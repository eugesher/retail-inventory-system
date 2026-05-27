import { Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';

import { ICurrentUser, RoleEnum } from '@retail-inventory-system/contracts';

import { ILoginCommand } from '../dto/login.command';
import { PASSWORD_HASHER, IPasswordPort } from '../ports/password.port';
import {
  IStaffUserRepositoryPort,
  STAFF_USER_REPOSITORY,
} from '../ports/staff-user.repository.port';
import { IIssuedTokens, ITokenPort, TOKEN_SERVICE } from '../ports/token.port';

export interface ILoginResult extends IIssuedTokens {
  user: ICurrentUser;
}

@Injectable()
export class LoginUseCase {
  constructor(
    @Inject(STAFF_USER_REPOSITORY) private readonly users: IStaffUserRepositoryPort,
    @Inject(PASSWORD_HASHER) private readonly hasher: IPasswordPort,
    @Inject(TOKEN_SERVICE) private readonly tokens: ITokenPort,
    @InjectPinoLogger(LoginUseCase.name) private readonly logger: PinoLogger,
  ) {}

  public async execute(command: ILoginCommand): Promise<ILoginResult> {
    const email = command.email.trim().toLowerCase();
    const user = await this.users.findByEmail(email);

    if (!user?.isActive) {
      this.logger.warn({ email }, 'LoginFailed: user not found or inactive');
      throw new UnauthorizedException('Invalid credentials');
    }

    const passwordValid = await user.validatePassword(command.password, this.hasher);
    if (!passwordValid) {
      this.logger.warn({ userId: user.id, email }, 'LoginFailed: bad password');
      throw new UnauthorizedException('Invalid credentials');
    }

    const accessJti = randomUUID();
    const refreshJti = randomUUID();
    const roles = user.roles.map((role) => role.name as RoleEnum);
    const permissions = Array.from(
      new Set(user.roles.flatMap((role) => Array.from(role.permissions))),
    ).sort();

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

    return {
      accessToken,
      refreshToken,
      refreshTokenJti: refreshJti,
      expiresIn: this.tokens.accessTokenExpiresInSeconds(),
      user: { id: user.id, email: user.email, roles, permissions },
    };
  }
}
