import { RoleEnum } from './role.enum';

export interface IJwtAccessPayload {
  sub: string;
  email: string;
  roles: RoleEnum[];
  jti: string;
  iat?: number;
  exp?: number;
}

export interface IJwtRefreshPayload {
  sub: string;
  jti: string;
  iat?: number;
  exp?: number;
}
