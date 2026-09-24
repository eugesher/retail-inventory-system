import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import { ICurrentUser } from '@retail-inventory-system/contracts';

interface IRequestWithUser {
  user?: ICurrentUser;
}

export function enforceRequiredClaim(
  reflector: Reflector,
  context: ExecutionContext,
  metadataKey: string,
  selectClaim: (user: ICurrentUser) => readonly string[] | undefined,
): boolean {
  const required = reflector.getAllAndOverride<string[] | undefined>(metadataKey, [
    context.getHandler(),
    context.getClass(),
  ]);

  if (!required || required.length === 0) {
    return true;
  }

  const { user } = context.switchToHttp().getRequest<IRequestWithUser>();
  const claim = user ? selectClaim(user) : undefined;

  if (!Array.isArray(claim) || !required.some((value) => claim.includes(value))) {
    throw new ForbiddenException('Insufficient permissions');
  }

  return true;
}
