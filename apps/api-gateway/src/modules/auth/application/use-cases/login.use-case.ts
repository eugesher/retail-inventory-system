import { Inject, Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { randomUUID } from 'crypto';

import { ICurrentUser } from '@retail-inventory-system/contracts';

import { ILoginCommand } from '../dto/login.command';
import { PASSWORD_HASHER, IPasswordPort } from '../ports/password.port';
import { IIssuedTokens, ITokenPort, TOKEN_SERVICE } from '../ports/token.port';
import { IUserRepositoryPort, USER_REPOSITORY } from '../ports/user.repository.port';

export interface ILoginResult extends IIssuedTokens {
  user: ICurrentUser;
}

@Injectable()
export class LoginUseCase {
  private readonly logger = new Logger(LoginUseCase.name);

  constructor(
    @Inject(USER_REPOSITORY) private readonly users: IUserRepositoryPort,
    @Inject(PASSWORD_HASHER) private readonly hasher: IPasswordPort,
    @Inject(TOKEN_SERVICE) private readonly tokens: ITokenPort,
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
    const roles = user.roles.map((role) => role.value);

    const accessToken = await this.tokens.issueAccessToken({
      sub: user.id,
      email: user.email,
      roles,
      jti: accessJti,
    });
    const refreshToken = await this.tokens.issueRefreshToken({
      sub: user.id,
      jti: refreshJti,
    });

    user.rotateRefreshTokenHash(await this.hasher.hash(refreshToken));
    user.recordLoggedIn();
    await this.users.save(user);

    this.logger.log({ userId: user.id }, 'UserLoggedIn');

    return {
      accessToken,
      refreshToken,
      refreshTokenJti: refreshJti,
      expiresIn: this.tokens.accessTokenExpiresInSeconds(),
      user: { id: user.id, email: user.email, roles },
    };
  }
}
