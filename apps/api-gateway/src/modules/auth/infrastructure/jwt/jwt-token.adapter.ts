import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService, JwtSignOptions } from '@nestjs/jwt';

import { IJwtAccessPayload, IJwtRefreshPayload } from '@retail-inventory-system/contracts';

import { ITokenPort } from '../../application/ports/token.port';

const SECONDS_PER_UNIT: Record<string, number> = {
  s: 1,
  m: 60,
  h: 3600,
  d: 86400,
};

const parseDuration = (value: string): number => {
  const match = /^(\d+)([smhd])$/.exec(value);
  if (!match) {
    const seconds = Number(value);
    if (!Number.isFinite(seconds) || seconds <= 0) {
      throw new Error(`Invalid JWT duration: ${value}`);
    }
    return seconds;
  }
  return Number(match[1]) * SECONDS_PER_UNIT[match[2]];
};

@Injectable()
export class JwtTokenAdapter implements ITokenPort {
  private readonly accessExpiresIn: string;
  private readonly refreshExpiresIn: string;
  private readonly refreshSecret: string;

  constructor(
    private readonly jwtService: JwtService,
    configService: ConfigService,
  ) {
    this.accessExpiresIn = configService.get<string>('JWT_ACCESS_EXPIRES_IN', '15m');
    this.refreshExpiresIn = configService.get<string>('JWT_REFRESH_EXPIRES_IN', '7d');
    this.refreshSecret = configService.get<string>('JWT_REFRESH_SECRET')!;
  }

  public issueAccessToken(payload: Omit<IJwtAccessPayload, 'iat' | 'exp'>): Promise<string> {
    return this.jwtService.signAsync(payload, {
      expiresIn: this.accessExpiresIn as JwtSignOptions['expiresIn'],
    });
  }

  public issueRefreshToken(payload: Omit<IJwtRefreshPayload, 'iat' | 'exp'>): Promise<string> {
    return this.jwtService.signAsync(payload, {
      secret: this.refreshSecret,
      expiresIn: this.refreshExpiresIn as JwtSignOptions['expiresIn'],
    });
  }

  public verifyRefresh(token: string): Promise<IJwtRefreshPayload> {
    return this.jwtService.verifyAsync<IJwtRefreshPayload>(token, { secret: this.refreshSecret });
  }

  public accessTokenExpiresInSeconds(): number {
    return parseDuration(this.accessExpiresIn);
  }
}
