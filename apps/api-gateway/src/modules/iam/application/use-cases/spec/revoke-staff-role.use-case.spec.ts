import { ConflictException, NotFoundException } from '@nestjs/common';

import { PermissionCodeEnum } from '@retail-inventory-system/contracts';

import { RoleAggregate, StaffUser } from '../../../../auth';
import { StaffUserRoleRevokedEvent } from '../../../../auth/domain/events/staff-user-role-revoked.event';
import { RevokeStaffRoleUseCase } from '../revoke-staff-role.use-case';
import { FakeAuditLogPublisher, InMemoryStaffUserRepository } from './test-doubles';

describe('RevokeStaffRoleUseCase', () => {
  let staffUsers: InMemoryStaffUserRepository;
  let audit: FakeAuditLogPublisher;
  let useCase: RevokeStaffRoleUseCase;

  let adminRole: RoleAggregate;
  let supportRole: RoleAggregate;

  beforeEach(() => {
    staffUsers = new InMemoryStaffUserRepository();
    audit = new FakeAuditLogPublisher();
    adminRole = RoleAggregate.create('role-admin', {
      name: 'admin',
      permissions: [PermissionCodeEnum.AUDIT_READ],
    });
    supportRole = RoleAggregate.create('role-support', {
      name: 'order-support',
      permissions: [PermissionCodeEnum.ORDER_READ],
    });

    useCase = new RevokeStaffRoleUseCase(staffUsers, audit);
  });

  it('revokes a role and records the event', async () => {
    staffUsers.seed(
      StaffUser.register('staff-1', {
        email: 'staff@example.com',
        passwordHash: 'hash:pw',
        roles: [adminRole, supportRole],
      }),
    );

    const result = await useCase.execute({ staffUserId: 'staff-1', roleName: 'order-support' });
    expect(result.roles.map((r) => r.name)).toEqual(['admin']);
    const events = result.pullDomainEvents();
    const revokedEvent = events.find(
      (e): e is StaffUserRoleRevokedEvent => e instanceof StaffUserRoleRevokedEvent,
    );
    expect(revokedEvent?.revokedRoleName).toBe('order-support');
  });

  it('throws NotFoundException when the staff user does not exist', async () => {
    await expect(
      useCase.execute({ staffUserId: 'missing', roleName: 'admin' }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('throws NotFoundException with "Role not bound" when the role is not on the user', async () => {
    staffUsers.seed(
      StaffUser.register('staff-1', {
        email: 'staff@example.com',
        passwordHash: 'hash:pw',
        roles: [supportRole],
      }),
    );

    let captured: NotFoundException | undefined;
    try {
      await useCase.execute({ staffUserId: 'staff-1', roleName: 'admin' });
    } catch (err) {
      captured = err as NotFoundException;
    }
    expect(captured).toBeInstanceOf(NotFoundException);
    expect(captured?.message).toBe('Role not bound');
  });

  it('throws ConflictException when revoking the last remaining role', async () => {
    staffUsers.seed(
      StaffUser.register('staff-1', {
        email: 'staff@example.com',
        passwordHash: 'hash:pw',
        roles: [supportRole],
      }),
    );

    let captured: ConflictException | undefined;
    try {
      await useCase.execute({ staffUserId: 'staff-1', roleName: 'order-support' });
    } catch (err) {
      captured = err as ConflictException;
    }
    expect(captured).toBeInstanceOf(ConflictException);
    expect(captured?.message).toBe('Cannot revoke the last remaining role');
  });

  describe('audit-log publishing', () => {
    it('publishes StaffUserRoleRevoked exactly once with the revoked name', async () => {
      staffUsers.seed(
        StaffUser.register('staff-1', {
          email: 'staff@example.com',
          passwordHash: 'hash:pw',
          roles: [adminRole, supportRole],
        }),
      );

      await useCase.execute({
        staffUserId: 'staff-1',
        roleName: 'order-support',
        actorId: 'staff-admin-1',
        correlationId: 'cid-revoke',
      });

      expect(audit.published).toHaveLength(1);
      expect(audit.published[0]).toMatchObject({
        name: 'StaffUserRoleRevoked',
        actorId: 'staff-admin-1',
        actorKind: 'staff',
        targetId: 'staff-1',
        targetKind: 'staff-user',
        correlationId: 'cid-revoke',
        payload: {
          revokedRoleName: 'order-support',
          currentRoleNames: ['admin'],
        },
      });
    });

    it('does not publish on the not-found / conflict branches', async () => {
      await expect(
        useCase.execute({ staffUserId: 'missing', roleName: 'admin' }),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(audit.published).toEqual([]);
    });
  });
});
