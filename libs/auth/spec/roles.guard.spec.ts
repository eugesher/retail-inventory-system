import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import { ICurrentUser } from '@retail-inventory-system/contracts';

import { Roles } from '../decorators/roles.decorator';
import { RolesGuard } from '../guards/roles.guard';
import { RoleEnum } from '../role.enum';

class StaffOnlyController {
  @Roles(RoleEnum.ADMIN)
  public adminOnly(): string {
    return 'admin-only';
  }

  @Roles(RoleEnum.ADMIN, RoleEnum.CATALOG_MANAGER)
  public adminOrCatalogManager(): string {
    return 'admin-or-catalog-manager';
  }

  public ungated(): string {
    return 'ungated';
  }
}

@Roles(RoleEnum.CATALOG_MANAGER)
class ClassGatedController {
  public inheritsClassGate(): string {
    return 'inherits';
  }

  @Roles(RoleEnum.ADMIN)
  public overridesWithAdmin(): string {
    return 'overrides';
  }
}

const contextFor = (
  target: object,
  method: string,
  user: ICurrentUser | undefined,
): ExecutionContext =>
  ({
    getHandler: () => (target.constructor.prototype as Record<string, unknown>)[method],
    getClass: () => target.constructor,
    switchToHttp: () => ({
      getRequest: <T>() => ({ user }) as T,
    }),
  }) as unknown as ExecutionContext;

const userWith = (roles: RoleEnum[]): ICurrentUser => ({
  id: 'fixture-user',
  email: 'fixture@example.com',
  roles,
  permissions: [],
});

describe('RolesGuard — against the real Reflector and a really decorated class', () => {
  const guard = new RolesGuard(new Reflector());
  const staff = new StaffOnlyController();
  const classGated = new ClassGatedController();

  it('reads the metadata the decorator wrote — the gate is closed to an outsider', () => {
    const ctx = contextFor(staff, 'adminOnly', userWith([RoleEnum.WAREHOUSE_STAFF]));

    expect(() => guard.canActivate(ctx)).toThrow(ForbiddenException);
  });

  it('admits a caller holding the required role', () => {
    const ctx = contextFor(staff, 'adminOnly', userWith([RoleEnum.ADMIN]));

    expect(guard.canActivate(ctx)).toBe(true);
  });

  it('admits a caller holding ANY one of several listed roles', () => {
    expect(
      guard.canActivate(
        contextFor(staff, 'adminOrCatalogManager', userWith([RoleEnum.CATALOG_MANAGER])),
      ),
    ).toBe(true);
    expect(
      guard.canActivate(contextFor(staff, 'adminOrCatalogManager', userWith([RoleEnum.ADMIN]))),
    ).toBe(true);
  });

  it('lets an undecorated handler through — no metadata means no gate', () => {
    const ctx = contextFor(staff, 'ungated', userWith([]));

    expect(guard.canActivate(ctx)).toBe(true);
  });

  it('applies a class-level @Roles to a handler that declares none', () => {
    expect(
      guard.canActivate(
        contextFor(classGated, 'inheritsClassGate', userWith([RoleEnum.CATALOG_MANAGER])),
      ),
    ).toBe(true);
    expect(() =>
      guard.canActivate(
        contextFor(classGated, 'inheritsClassGate', userWith([RoleEnum.WAREHOUSE_STAFF])),
      ),
    ).toThrow(ForbiddenException);
  });

  it('lets a handler-level @Roles override the class-level one rather than union with it', () => {
    expect(
      guard.canActivate(contextFor(classGated, 'overridesWithAdmin', userWith([RoleEnum.ADMIN]))),
    ).toBe(true);
    expect(() =>
      guard.canActivate(
        contextFor(classGated, 'overridesWithAdmin', userWith([RoleEnum.CATALOG_MANAGER])),
      ),
    ).toThrow(ForbiddenException);
  });

  it('refuses when request.user is absent', () => {
    const ctx = contextFor(staff, 'adminOnly', undefined);

    expect(() => guard.canActivate(ctx)).toThrow(ForbiddenException);
  });

  it('refuses a subject whose roles claim is missing entirely', () => {
    const malformed = { id: 'u', email: 'e', permissions: [] } as unknown as ICurrentUser;
    const ctx = contextFor(staff, 'adminOnly', malformed);

    expect(() => guard.canActivate(ctx)).toThrow(ForbiddenException);
  });
});
