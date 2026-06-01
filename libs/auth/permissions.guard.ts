import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import { enforceRequiredClaim } from './claim-guard.util';
import { REQUIRES_PERMISSION_KEY } from './requires-permission.decorator';

@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  public canActivate(context: ExecutionContext): boolean {
    return enforceRequiredClaim(
      this.reflector,
      context,
      REQUIRES_PERMISSION_KEY,
      (user) => user.permissions,
    );
  }
}
