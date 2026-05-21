import { IJwtAccessPayload, IJwtRefreshPayload } from '@retail-inventory-system/contracts';

export const TOKEN_SERVICE = Symbol('TOKEN_SERVICE');

export interface IIssuedTokens {
  accessToken: string;
  refreshToken: string;
  refreshTokenJti: string;
  expiresIn: number;
}

export interface ITokenPort {
  issueAccessToken(payload: Omit<IJwtAccessPayload, 'iat' | 'exp'>): Promise<string>;
  issueRefreshToken(payload: Omit<IJwtRefreshPayload, 'iat' | 'exp'>): Promise<string>;
  verifyRefresh(token: string): Promise<IJwtRefreshPayload>;
  // Sourced from JWT_ACCESS_EXPIRES_IN.
  accessTokenExpiresInSeconds(): number;
}
