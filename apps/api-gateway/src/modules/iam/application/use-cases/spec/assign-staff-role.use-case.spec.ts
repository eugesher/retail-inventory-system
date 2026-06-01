import { BadRequestException, NotFoundException } from '@nestjs/common';

import { PermissionCodeEnum } from '@retail-inventory-system/contracts';

import { RoleAggregate, StaffUser } from '../../../../auth';
import { StaffUserRolesAssignedEvent } from '../../../../auth/domain/events/staff-user-roles-assigned.event';
import { AssignStaffRoleUseCase } from '../assign-staff-role.use-case';
import {
  FakeAuditLogPublisher,
  InMemoryRoleRepository,
  InMemoryStaffUserRepository,
} from './test-doubles';

const seedStaffUser = (roles: RoleAggregate[]): StaffUser =>
  StaffUser.register('staff-1', {
    email: 'staff@example.com',
    passwordHash: 'hash:pw',
    roles,
  });

describe('AssignStaffRoleUseCase', () => {
  let staffUsers: InMemoryStaffUserRepository;
  let roles: InMemoryRoleRepository;
  let audit: FakeAuditLogPublisher;
  let useCase: AssignStaffRoleUseCase;

  let adminRole: RoleAggregate;
  let supportRole: RoleAggregate;

  beforeEach(() => {
    staffUsers = new InMemoryStaffUserRepository();
    roles = new InMemoryRoleRepository();
    audit = new FakeAuditLogPublisher();

    adminRole = RoleAggregate.create('role-admin', {
      name: 'admin',
      permissions: [PermissionCodeEnum.AUDIT_READ],
    });
    supportRole = RoleAggregate.create('role-support', {
      name: 'order-support',
      permissions: [PermissionCodeEnum.ORDER_READ],
    });
    roles.seed(adminRole);
    roles.seed(supportRole);
    staffUsers.seed(seedStaffUser([supportRole]));

    useCase = new AssignStaffRoleUseCase(staffUsers, roles, audit);
  });

  it('assigns a new role and records the diff in the domain event', async () => {
    const result = await useCase.execute({ staffUserId: 'staff-1', roleNames: ['admin'] });

    expect(result.roles.map((r) => r.name).sort()).toEqual(['admin', 'order-support']);
    const events = result.pullDomainEvents();
    const assignedEvent = events.find(
      (e): e is StaffUserRolesAssignedEvent => e instanceof StaffUserRolesAssignedEvent,
    );
    expect(assignedEvent?.assignedRoleNames).toEqual(['admin']);
  });

  it('is idempotent when re-assigning a role the user already has', async () => {
    const result = await useCase.execute({
      staffUserId: 'staff-1',
      roleNames: ['order-support'],
    });

    expect(result.roles.map((r) => r.name)).toEqual(['order-support']);
    const events = result.pullDomainEvents();
    const assignedEvent = events.find(
      (e): e is StaffUserRolesAssignedEvent => e instanceof StaffUserRolesAssignedEvent,
    );
    expect(assignedEvent).toBeUndefined();
  });

  it('throws BadRequestException on an unknown role name', async () => {
    await expect(
      useCase.execute({ staffUserId: 'staff-1', roleNames: ['nope'] }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('throws NotFoundException when the staff user does not exist', async () => {
    await expect(
      useCase.execute({ staffUserId: 'missing', roleNames: ['admin'] }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('throws NotFoundException when the staff user is suspended', async () => {
    const suspended = seedStaffUser([supportRole]);
    suspended.suspend();
    staffUsers.seed(suspended);

    await expect(
      useCase.execute({ staffUserId: 'staff-1', roleNames: ['admin'] }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  describe('audit-log publishing', () => {
    it('publishes StaffUserRolesAssigned with the *added* role-name diff', async () => {
      await useCase.execute({
        staffUserId: 'staff-1',
        roleNames: ['admin'],
        actorId: 'staff-admin-1',
        correlationId: 'cid-assign',
      });

      expect(audit.published).toHaveLength(1);
      expect(audit.published[0]).toMatchObject({
        name: 'StaffUserRolesAssigned',
        actorId: 'staff-admin-1',
        actorKind: 'staff',
        targetId: 'staff-1',
        targetKind: 'staff-user',
        correlationId: 'cid-assign',
        payload: {
          requestedRoleNames: ['admin'],
          addedRoleNames: ['admin'],
        },
      });
      expect(
        (audit.published[0].payload as { currentRoleNames: string[] }).currentRoleNames.sort(),
      ).toEqual(['admin', 'order-support']);
    });

    it('publishes StaffUserRolesAssigned with an empty addedRoleNames on idempotent re-assign', async () => {
      await useCase.execute({
        staffUserId: 'staff-1',
        roleNames: ['order-support'],
        actorId: 'staff-admin-1',
      });

      expect(audit.published).toHaveLength(1);
      expect(audit.published[0]).toMatchObject({
        name: 'StaffUserRolesAssigned',
        payload: {
          requestedRoleNames: ['order-support'],
          addedRoleNames: [],
          currentRoleNames: ['order-support'],
        },
      });
    });

    it('does not publish on the validation-failure branches', async () => {
      await expect(
        useCase.execute({ staffUserId: 'staff-1', roleNames: ['nope'] }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(audit.published).toEqual([]);
    });
  });
});
