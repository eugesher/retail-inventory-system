import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import { ICurrentUser } from '@retail-inventory-system/contracts';

import { REQUIRES_PERMISSION_KEY } from './requires-permission.decorator';

interface IRequestWithUser {
  user?: ICurrentUser;
}

@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  public canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<string[] | undefined>(
      REQUIRES_PERMISSION_KEY,
      [context.getHandler(), context.getClass()],
    );

    if (!required || required.length === 0) {
      return true;
    }

    const request: IRequestWithUser = context.switchToHttp().getRequest<IRequestWithUser>();
    const user = request.user;

    if (!user || !Array.isArray(user.permissions)) {
      throw new ForbiddenException('Insufficient permissions');
    }

    const ok = required.some((code) => user.permissions.includes(code));
    if (!ok) {
      throw new ForbiddenException('Insufficient permissions');
    }

    return true;
  }
}
