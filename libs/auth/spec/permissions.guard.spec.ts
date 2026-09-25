import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import { ICurrentUser } from '@retail-inventory-system/contracts';

import { PermissionsGuard } from '../guards/permissions.guard';
import { RoleEnum } from '../role.enum';

const buildContext = (request: { user?: ICurrentUser | undefined }): ExecutionContext =>
  ({
    getHandler: () => () => undefined,
    getClass: () => class {},
    switchToHttp: () => ({
      getRequest: <T>() => request as T,
    }),
  }) as unknown as ExecutionContext;

const buildReflector = (metadata: string[] | undefined): Reflector =>
  ({
    getAllAndOverride: <T>(): T => metadata as unknown as T,
  }) as unknown as Reflector;

describe('PermissionsGuard', () => {
  const user = (permissions: string[]): ICurrentUser => ({
    id: 'fixture-user',
    email: 'fixture@example.com',
    roles: [RoleEnum.ADMIN],
    permissions,
  });

  it('allows when no @RequiresPermission metadata is set', () => {
    const guard = new PermissionsGuard(buildReflector(undefined));
    const ctx = buildContext({ user: user(['catalog:read']) });

    expect(guard.canActivate(ctx)).toBe(true);
  });

  it('throws ForbiddenException when the caller lacks the required permission', () => {
    const guard = new PermissionsGuard(buildReflector(['catalog:write']));
    const ctx = buildContext({ user: user(['catalog:read']) });

    expect(() => guard.canActivate(ctx)).toThrow(ForbiddenException);
  });

  it('allows when the caller holds the single required permission', () => {
    const guard = new PermissionsGuard(buildReflector(['catalog:write']));
    const ctx = buildContext({ user: user(['catalog:write', 'audit:read']) });

    expect(guard.canActivate(ctx)).toBe(true);
  });

  it('allows when the caller holds any one of multiple required permissions (OR-semantics)', () => {
    const guard = new PermissionsGuard(buildReflector(['catalog:write', 'catalog:publish']));
    const ctx = buildContext({ user: user(['catalog:publish']) });

    expect(guard.canActivate(ctx)).toBe(true);
  });

  it('throws ForbiddenException when request.user is undefined (defensive — JwtAuthGuard should have rejected)', () => {
    const guard = new PermissionsGuard(buildReflector(['catalog:write']));
    const ctx = buildContext({ user: undefined });

    expect(() => guard.canActivate(ctx)).toThrow(ForbiddenException);
  });
});
