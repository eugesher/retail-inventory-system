import { PermissionCodeEnum } from '@retail-inventory-system/contracts';

import { StaffUserRoleRevokedEvent, StaffUserRolesAssignedEvent } from '../events';
import { RoleAggregate } from '../role.aggregate';
import { IPasswordHasher, StaffUser } from '../staff-user.model';

const ADMIN_ROLE_ID = '11111111-1111-4111-a111-111111111111';
const SUPPORT_ROLE_ID = '22222222-2222-4222-a222-222222222222';
const STAFF_ID = '33333333-3333-4333-a333-333333333333';

const adminRole = (): RoleAggregate =>
  RoleAggregate.create(ADMIN_ROLE_ID, {
    name: 'admin',
    permissions: [PermissionCodeEnum.AUDIT_READ],
  });

const supportRole = (): RoleAggregate =>
  RoleAggregate.create(SUPPORT_ROLE_ID, {
    name: 'order-support',
    permissions: [PermissionCodeEnum.ORDER_READ],
  });

const makeStaff = (overrides: Partial<Parameters<typeof StaffUser.register>[1]> = {}): StaffUser =>
  StaffUser.register(STAFF_ID, {
    email: overrides.email ?? 'STAFF@Example.com',
    passwordHash: overrides.passwordHash ?? 'argon2-hash',
    roles: overrides.roles ?? [adminRole()],
    status: overrides.status,
    lastLoginAt: overrides.lastLoginAt,
    refreshTokenHash: overrides.refreshTokenHash,
  });

describe('StaffUser', () => {
  describe('construction invariants', () => {
    it('lowercases the email on register', () => {
      const user = makeStaff({ email: 'MixedCase@Example.COM' });
      expect(user.email).toBe('mixedcase@example.com');
    });

    it('rejects a malformed email', () => {
      expect(() => makeStaff({ email: 'not-an-email' })).toThrow(/email must be a valid email/);
    });

    it('rejects an empty passwordHash', () => {
      expect(() => makeStaff({ passwordHash: '' })).toThrow(/passwordHash must be non-empty/);
    });

    it('rejects an empty roles array', () => {
      expect(() => makeStaff({ roles: [] })).toThrow(/roles must be non-empty/);
    });

    it('defaults status to "active" and lastLoginAt to null', () => {
      const user = makeStaff();
      expect(user.status).toBe('active');
      expect(user.lastLoginAt).toBeNull();
      expect(user.isActive).toBe(true);
    });
  });

  describe('status transitions', () => {
    it('suspend → reactivate flips status and isActive', () => {
      const user = makeStaff();
      user.suspend();
      expect(user.status).toBe('suspended');
      expect(user.isActive).toBe(false);

      user.reactivate();
      expect(user.status).toBe('active');
      expect(user.isActive).toBe(true);
    });
  });

  describe('toJSON / passwordHash leakage', () => {
    it('never serializes passwordHash via JSON.stringify', () => {
      const user = makeStaff({ passwordHash: 'argon2-very-secret' });
      const serialized = JSON.stringify(user);

      expect(serialized).not.toContain('argon2-very-secret');
      expect(serialized).not.toContain('passwordHash');
    });

    it('never serializes refreshTokenHash via JSON.stringify', () => {
      const user = makeStaff({ refreshTokenHash: 'token-hash-secret' });
      const serialized = JSON.stringify(user);

      expect(serialized).not.toContain('token-hash-secret');
      expect(serialized).not.toContain('refreshTokenHash');
    });
  });

  describe('assignRole / revokeRole', () => {
    it('assignRole is idempotent — same role id is a no-op', () => {
      const user = makeStaff({ roles: [adminRole()] });
      user.assignRole(adminRole());
      expect(user.roles).toHaveLength(1);
    });

    it('assignRole appends a distinct role', () => {
      const user = makeStaff({ roles: [adminRole()] });
      user.assignRole(supportRole());
      expect(user.roles.map((r) => r.id)).toEqual([ADMIN_ROLE_ID, SUPPORT_ROLE_ID]);
    });

    it('revokeRole drops a role when more than one remains', () => {
      const user = makeStaff({ roles: [adminRole(), supportRole()] });
      user.revokeRole(supportRole());
      expect(user.roles.map((r) => r.id)).toEqual([ADMIN_ROLE_ID]);
    });

    it('revokeRole refuses to remove the last role', () => {
      const user = makeStaff({ roles: [adminRole()] });
      expect(() => user.revokeRole(adminRole())).toThrow(/last remaining role/);
    });
  });

  // These live here, on the aggregate, and NOT on an IAM use case's `save()` return. Nothing in
  // production drains this queue — `docs/implementation/01-…/05-iam-admin-endpoints.md` calls it
  // latent scaffolding and names `AUDIT_LOG_PUBLISHER` as the effective audit surface — and a
  // repository's `save` returns a reconstituted aggregate, which carries no events at all. Three
  // use-case specs used to assert them off that return; they passed only because an in-memory
  // double handed back its own argument.
  //
  // The diff itself is the use case's to compute (see `recordRolesAssigned`'s note in the model);
  // what the aggregate owes is recording exactly what it was handed.
  describe('recordRolesAssigned / recordRoleRevoked', () => {
    // `register` records a `StaffUserRegisteredEvent`, so every case drains first.
    const freshStaff = (): StaffUser => {
      const user = makeStaff();
      user.pullDomainEvents();
      return user;
    };

    it('records StaffUserRolesAssigned carrying the supplied diff', () => {
      const user = freshStaff();

      user.recordRolesAssigned(['admin']);

      const assigned = user
        .pullDomainEvents()
        .find((e): e is StaffUserRolesAssignedEvent => e instanceof StaffUserRolesAssignedEvent);
      expect(assigned?.assignedRoleNames).toEqual(['admin']);
    });

    it('records nothing when the diff is empty — the idempotent re-assign', () => {
      const user = freshStaff();

      user.recordRolesAssigned([]);

      expect(user.pullDomainEvents()).toHaveLength(0);
    });

    it('records StaffUserRoleRevoked carrying the revoked name', () => {
      const user = freshStaff();

      user.recordRoleRevoked('order-support');

      const revoked = user
        .pullDomainEvents()
        .find((e): e is StaffUserRoleRevokedEvent => e instanceof StaffUserRoleRevokedEvent);
      expect(revoked?.revokedRoleName).toBe('order-support');
    });
  });

  describe('recordLoggedIn', () => {
    it('updates lastLoginAt and emits StaffUserLoggedInEvent', () => {
      const user = makeStaff();
      const at = new Date('2026-05-28T10:00:00.000Z');

      user.recordLoggedIn(at);

      expect(user.lastLoginAt).toEqual(at);
      const events = user.pullDomainEvents();
      const loginEvent = events.find((e) => e.constructor.name === 'StaffUserLoggedInEvent');
      expect(loginEvent).toBeDefined();
    });
  });

  describe('validatePassword', () => {
    it('delegates to the supplied hasher', async () => {
      const verifyMock = jest.fn().mockResolvedValue(true);
      const hasher: IPasswordHasher = { verify: verifyMock };
      const user = makeStaff({ passwordHash: 'argon2-stored' });

      const result = await user.validatePassword('candidate', hasher);

      expect(result).toBe(true);
      expect(verifyMock).toHaveBeenCalledWith('argon2-stored', 'candidate');
    });
  });
});
