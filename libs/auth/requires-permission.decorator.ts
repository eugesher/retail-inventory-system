import { SetMetadata } from '@nestjs/common';

export const REQUIRES_PERMISSION_KEY = 'auth:requires-permission';

export const RequiresPermission = (...permissions: string[]): MethodDecorator & ClassDecorator =>
  SetMetadata(REQUIRES_PERMISSION_KEY, permissions);
