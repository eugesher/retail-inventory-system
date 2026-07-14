import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import { ICurrentUser } from '@retail-inventory-system/contracts';

import { Roles } from '../decorators/roles.decorator';
import { RolesGuard } from '../guards/roles.guard';
import { RoleEnum } from '../role.enum';

// `RolesGuard` had no spec, and `@Roles()` is applied to **no route in the repository** — the coarse
// role gate is a capability the system offers and has never used (`@RequiresPermission` does the real
// work). That is a legitimate reserved surface, not dead code. But a reserved capability with no test
// is a capability nobody can rely on: the day someone reaches for `@Roles(RoleEnum.ADMIN)` they would
// be the first person ever to run it.
//
// **So this suite uses the REAL `Reflector` against a REALLY decorated class**, where
// `permissions.guard.spec.ts` hand-stubs `getAllAndOverride` and returns whatever the case needs. The
// stub is fine for the guard's branching, and it cannot prove the one thing that binds the two halves
// together: **that the guard reads the key the decorator writes.** A decorator writing `auth:role` and
// a guard reading `auth:roles` would pass every hand-stubbed test in the repository and let every
// caller through, silently — a gate that is open is a gate that never complains.

// A stand-in controller, decorated for real. Instantiating the decorator is the point: this is the only
// place in the codebase where `Roles(...)` is actually invoked.
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

// Class-level `@Roles`, with a handler that overrides it — `getAllAndOverride` takes the HANDLER's
// metadata when both are present, and that precedence is a decision, not an accident.
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

// The context the guard sees. It hands back the REAL method and the REAL class, so the real `Reflector`
// reads the real metadata — nothing about the decorator/guard contract is simulated.
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

  // **The binding test.** If `@Roles` and `RolesGuard` ever disagreed about `ROLES_KEY`, the guard
  // would find no metadata, conclude the route is ungated, and admit everybody. This asserts the gate
  // is actually closed — which is the assertion a hand-stubbed Reflector cannot make.
  it('reads the metadata the decorator wrote — the gate is closed to an outsider', () => {
    const ctx = contextFor(staff, 'adminOnly', userWith([RoleEnum.WAREHOUSE_STAFF]));

    expect(() => guard.canActivate(ctx)).toThrow(ForbiddenException);
  });

  it('admits a caller holding the required role', () => {
    const ctx = contextFor(staff, 'adminOnly', userWith([RoleEnum.ADMIN]));

    expect(guard.canActivate(ctx)).toBe(true);
  });

  // OR-semantics: any one of the listed roles suffices. `@Roles(A, B)` is a bundle, not a conjunction —
  // reading it as AND would lock out every caller who holds exactly one of them, i.e. almost everyone.
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

  // `getAllAndOverride([handler, class])` — the handler WINS. A method that names its own roles is not
  // widened by the class's; it replaces them. Here that means a CATALOG_MANAGER, admitted at the class level, is
  // refused by a handler that asks for ADMIN.
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

  // Defensive: `JwtAuthGuard` runs first and should have rejected an anonymous request. If the guard
  // order is ever changed, this must still refuse rather than read `roles` off `undefined`.
  it('refuses when request.user is absent', () => {
    const ctx = contextFor(staff, 'adminOnly', undefined);

    expect(() => guard.canActivate(ctx)).toThrow(ForbiddenException);
  });

  // A subject with no roles array at all — a malformed or partially-populated JWT payload. `Array
  // .isArray` is what stops `undefined.includes` from becoming a 500 on a route that should answer 403.
  it('refuses a subject whose roles claim is missing entirely', () => {
    const malformed = { id: 'u', email: 'e', permissions: [] } as unknown as ICurrentUser;
    const ctx = contextFor(staff, 'adminOnly', malformed);

    expect(() => guard.canActivate(ctx)).toThrow(ForbiddenException);
  });
});
