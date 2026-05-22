import { Inject, Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { randomUUID } from 'crypto';

import { IJwtRefreshPayload } from '@retail-inventory-system/contracts';

import { IRefreshCommand } from '../dto/refresh.command';
import { PASSWORD_HASHER, IPasswordPort } from '../ports/password.port';
import { IIssuedTokens, ITokenPort, TOKEN_SERVICE } from '../ports/token.port';
import { IUserRepositoryPort, USER_REPOSITORY } from '../ports/user.repository.port';

@Injectable()
export class RefreshTokenUseCase {
  private readonly logger = new Logger(RefreshTokenUseCase.name);

  constructor(
    @Inject(USER_REPOSITORY) private readonly users: IUserRepositoryPort,
    @Inject(PASSWORD_HASHER) private readonly hasher: IPasswordPort,
    @Inject(TOKEN_SERVICE) private readonly tokens: ITokenPort,
  ) {}

  public async execute(command: IRefreshCommand): Promise<IIssuedTokens> {
    let payload: IJwtRefreshPayload;
    try {
      payload = await this.tokens.verifyRefresh(command.refreshToken);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'unknown';
      this.logger.warn({ err: message }, 'RefreshFailed: signature/expiry');
      throw new UnauthorizedException('Invalid refresh token');
    }

    const user = await this.users.findById(payload.sub);
    if (!user || !user.isActive || !user.refreshTokenHash) {
      this.logger.warn({ sub: payload.sub }, 'RefreshFailed: user missing or inactive');
      throw new UnauthorizedException('Invalid refresh token');
    }

    const matches = await this.hasher.verify(user.refreshTokenHash, command.refreshToken);
    if (!matches) {
      // Rotation reuse — clear the live hash so a leaked stale refresh token
      // can't roll forward (ADR-010).
      user.rotateRefreshTokenHash(null);
      await this.users.save(user);
      this.logger.warn({ userId: user.id }, 'RefreshFailed: rotation reuse detected');
      throw new UnauthorizedException('Invalid refresh token');
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
    await this.users.save(user);

    this.logger.log({ userId: user.id }, 'RefreshTokenRotated');

    return {
      accessToken,
      refreshToken,
      refreshTokenJti: refreshJti,
      expiresIn: this.tokens.accessTokenExpiresInSeconds(),
    };
  }
}
