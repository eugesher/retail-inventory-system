import { SetMetadata } from '@nestjs/common';

import { RoleEnum } from './role.enum';

export const ROLES_KEY = 'auth:roles';

export const Roles = (...roles: RoleEnum[]): MethodDecorator & ClassDecorator =>
  SetMetadata(ROLES_KEY, roles);
