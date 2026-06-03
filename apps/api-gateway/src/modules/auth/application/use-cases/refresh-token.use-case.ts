import { Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';

import {
  AUDIT_LOG_PUBLISHER,
  IAuditLogPublisher,
  IJwtRefreshPayload,
} from '@retail-inventory-system/contracts';

import { IRefreshCommand } from '../dto';
import {
  CUSTOMER_REPOSITORY,
  ICustomerRepositoryPort,
  IIssuedTokens,
  IPasswordPort,
  IStaffUserRepositoryPort,
  ITokenPort,
  PASSWORD_HASHER,
  STAFF_USER_REPOSITORY,
  TOKEN_SERVICE,
} from '../ports';
import { resolveAuthSubject } from './resolve-auth-subject';

@Injectable()
export class RefreshTokenUseCase {
  constructor(
    @Inject(STAFF_USER_REPOSITORY) private readonly staff: IStaffUserRepositoryPort,
    @Inject(CUSTOMER_REPOSITORY) private readonly customers: ICustomerRepositoryPort,
    @Inject(PASSWORD_HASHER) private readonly hasher: IPasswordPort,
    @Inject(TOKEN_SERVICE) private readonly tokens: ITokenPort,
    @Inject(AUDIT_LOG_PUBLISHER) private readonly audit: IAuditLogPublisher,
    @InjectPinoLogger(RefreshTokenUseCase.name) private readonly logger: PinoLogger,
  ) {}

  public async execute(command: IRefreshCommand): Promise<IIssuedTokens> {
    const correlationId = command.correlationId ?? null;
    let payload: IJwtRefreshPayload;
    try {
      payload = await this.tokens.verifyRefresh(command.refreshToken);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'unknown';
      this.logger.warn({ err: message }, 'RefreshFailed: signature/expiry');
      await this.audit.publish({
        name: 'RefreshFailed',
        actorId: null,
        actorKind: 'anonymous',
        targetId: null,
        targetKind: null,
        payload: { reason: 'signature-or-expiry' },
        correlationId,
      });
      throw new UnauthorizedException('Invalid refresh token');
    }

    // Resolve across both identity spaces — staff and customers share the
    // `/auth/refresh` route and both are issued refresh tokens at login.
    const resolved = await resolveAuthSubject(this.staff, this.customers, payload.sub);
    const subject = resolved?.subject;
    if (!resolved || !subject || !subject.isActive || !subject.refreshTokenHash) {
      this.logger.warn({ sub: payload.sub }, 'RefreshFailed: user missing or inactive');
      await this.audit.publish({
        name: 'RefreshFailed',
        actorId: null,
        actorKind: 'anonymous',
        targetId: payload.sub,
        targetKind: resolved?.targetKind ?? null,
        payload: { reason: 'user-missing-or-inactive' },
        correlationId,
      });
      throw new UnauthorizedException('Invalid refresh token');
    }

    const matches = await this.hasher.verify(subject.refreshTokenHash, command.refreshToken);
    if (!matches) {
      // Rotation reuse — clear the live hash so a leaked stale refresh token
      // can't roll forward (ADR-010).
      subject.rotateRefreshTokenHash(null);
      await resolved.persist();
      this.logger.warn({ userId: subject.id }, 'RefreshFailed: rotation reuse detected');
      await this.audit.publish({
        name: 'RefreshReuseDetected',
        actorId: subject.id,
        actorKind: resolved.actorKind,
        targetId: subject.id,
        targetKind: resolved.targetKind,
        payload: { reason: 'rotation-reuse' },
        correlationId,
      });
      throw new UnauthorizedException('Invalid refresh token');
    }

    const accessJti = randomUUID();
    const refreshJti = randomUUID();

    const accessToken = await this.tokens.issueAccessToken({
      sub: subject.id,
      email: subject.email,
      roles: resolved.roles,
      permissions: resolved.permissions,
      jti: accessJti,
    });
    const refreshToken = await this.tokens.issueRefreshToken({
      sub: subject.id,
      jti: refreshJti,
    });

    subject.rotateRefreshTokenHash(await this.hasher.hash(refreshToken));
    await resolved.persist();

    this.logger.info({ userId: subject.id }, 'RefreshTokenRotated');
    await this.audit.publish({
      name: 'RefreshTokenRotated',
      actorId: subject.id,
      actorKind: resolved.actorKind,
      targetId: subject.id,
      targetKind: resolved.targetKind,
      payload: { refreshJti },
      correlationId,
    });

    return {
      accessToken,
      refreshToken,
      refreshTokenJti: refreshJti,
      expiresIn: this.tokens.accessTokenExpiresInSeconds(),
    };
  }
}
