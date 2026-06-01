import { Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';

import {
  AUDIT_LOG_PUBLISHER,
  IAuditLogPublisher,
  IJwtRefreshPayload,
  RoleEnum,
} from '@retail-inventory-system/contracts';

import { IRefreshCommand } from '../dto';
import {
  IIssuedTokens,
  IPasswordPort,
  IStaffUserRepositoryPort,
  ITokenPort,
  PASSWORD_HASHER,
  STAFF_USER_REPOSITORY,
  TOKEN_SERVICE,
} from '../ports';

@Injectable()
export class RefreshTokenUseCase {
  constructor(
    @Inject(STAFF_USER_REPOSITORY) private readonly users: IStaffUserRepositoryPort,
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

    const user = await this.users.findById(payload.sub);
    if (!user || !user.isActive || !user.refreshTokenHash) {
      this.logger.warn({ sub: payload.sub }, 'RefreshFailed: user missing or inactive');
      await this.audit.publish({
        name: 'RefreshFailed',
        actorId: null,
        actorKind: 'anonymous',
        targetId: payload.sub,
        targetKind: 'staff-user',
        payload: { reason: 'user-missing-or-inactive' },
        correlationId,
      });
      throw new UnauthorizedException('Invalid refresh token');
    }

    const matches = await this.hasher.verify(user.refreshTokenHash, command.refreshToken);
    if (!matches) {
      // Rotation reuse — clear the live hash so a leaked stale refresh token
      // can't roll forward (ADR-010).
      user.rotateRefreshTokenHash(null);
      await this.users.save(user);
      this.logger.warn({ userId: user.id }, 'RefreshFailed: rotation reuse detected');
      await this.audit.publish({
        name: 'RefreshReuseDetected',
        actorId: user.id,
        actorKind: 'staff',
        targetId: user.id,
        targetKind: 'staff-user',
        payload: { reason: 'rotation-reuse' },
        correlationId,
      });
      throw new UnauthorizedException('Invalid refresh token');
    }

    const accessJti = randomUUID();
    const refreshJti = randomUUID();
    const roles = user.roleNames as RoleEnum[];
    const permissions = user.permissionCodes;

    const accessToken = await this.tokens.issueAccessToken({
      sub: user.id,
      email: user.email,
      roles,
      permissions,
      jti: accessJti,
    });
    const refreshToken = await this.tokens.issueRefreshToken({
      sub: user.id,
      jti: refreshJti,
    });

    user.rotateRefreshTokenHash(await this.hasher.hash(refreshToken));
    await this.users.save(user);

    this.logger.info({ userId: user.id }, 'RefreshTokenRotated');
    await this.audit.publish({
      name: 'RefreshTokenRotated',
      actorId: user.id,
      actorKind: 'staff',
      targetId: user.id,
      targetKind: 'staff-user',
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
