import { RoleEnum } from './role.enum';

export interface IJwtAccessPayload {
  sub: string;
  email: string;
  roles: RoleEnum[];
  permissions: string[];
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
