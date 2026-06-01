import { Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';

import {
  AUDIT_LOG_PUBLISHER,
  IAuditLogPublisher,
  ICurrentUser,
  RoleEnum,
} from '@retail-inventory-system/contracts';

import { ILoginCommand } from '../dto';
import {
  IIssuedTokens,
  IPasswordPort,
  IStaffUserRepositoryPort,
  ITokenPort,
  PASSWORD_HASHER,
  STAFF_USER_REPOSITORY,
  TOKEN_SERVICE,
} from '../ports';

interface ILoginResult extends IIssuedTokens {
  user: ICurrentUser;
}

@Injectable()
export class LoginUseCase {
  constructor(
    @Inject(STAFF_USER_REPOSITORY) private readonly users: IStaffUserRepositoryPort,
    @Inject(PASSWORD_HASHER) private readonly hasher: IPasswordPort,
    @Inject(TOKEN_SERVICE) private readonly tokens: ITokenPort,
    @Inject(AUDIT_LOG_PUBLISHER) private readonly audit: IAuditLogPublisher,
    @InjectPinoLogger(LoginUseCase.name) private readonly logger: PinoLogger,
  ) {}

  public async execute(command: ILoginCommand): Promise<ILoginResult> {
    const email = command.email.trim().toLowerCase();
    const correlationId = command.correlationId ?? null;
    const user = await this.users.findByEmail(email);

    if (!user?.isActive) {
      this.logger.warn({ email }, 'LoginFailed: user not found or inactive');
      await this.audit.publish({
        name: 'LoginFailed',
        actorId: null,
        actorKind: 'anonymous',
        targetId: null,
        targetKind: null,
        payload: { email, reason: 'user-not-found' },
        correlationId,
      });
      throw new UnauthorizedException('Invalid credentials');
    }

    const passwordValid = await user.validatePassword(command.password, this.hasher);
    if (!passwordValid) {
      this.logger.warn({ userId: user.id, email }, 'LoginFailed: bad password');
      await this.audit.publish({
        name: 'LoginFailed',
        actorId: null,
        actorKind: 'anonymous',
        targetId: user.id,
        targetKind: 'staff-user',
        payload: { email, reason: 'bad-password' },
        correlationId,
      });
      throw new UnauthorizedException('Invalid credentials');
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
    user.recordLoggedIn();
    await this.users.save(user);

    this.logger.info({ userId: user.id }, 'StaffUserLoggedIn');
    await this.audit.publish({
      name: 'UserLoggedIn',
      actorId: user.id,
      actorKind: 'staff',
      targetId: user.id,
      targetKind: 'staff-user',
      payload: { email: user.email, roles, permissions },
      correlationId,
    });

    return {
      accessToken,
      refreshToken,
      refreshTokenJti: refreshJti,
      expiresIn: this.tokens.accessTokenExpiresInSeconds(),
      user: { id: user.id, email: user.email, roles, permissions },
    };
  }
}
