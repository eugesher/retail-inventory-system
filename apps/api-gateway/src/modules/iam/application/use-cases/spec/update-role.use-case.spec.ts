import { BadRequestException, NotFoundException } from '@nestjs/common';

import { PermissionCodeEnum } from '@retail-inventory-system/contracts';

import { PermissionAggregate, RoleAggregate } from '../../../../auth';
import { UpdateRoleUseCase } from '../update-role.use-case';
import {
  FakeAuditLogPublisher,
  InMemoryPermissionRepository,
  InMemoryRoleRepository,
} from './test-doubles';

describe('UpdateRoleUseCase', () => {
  let roles: InMemoryRoleRepository;
  let permissions: InMemoryPermissionRepository;
  let audit: FakeAuditLogPublisher;
  let useCase: UpdateRoleUseCase;

  beforeEach(() => {
    roles = new InMemoryRoleRepository();
    permissions = new InMemoryPermissionRepository();
    audit = new FakeAuditLogPublisher();
    permissions.seed(PermissionAggregate.create('p1', { code: PermissionCodeEnum.AUDIT_READ }));
    permissions.seed(PermissionAggregate.create('p2', { code: PermissionCodeEnum.IAM_ROLE_EDIT }));
    roles.seed(
      RoleAggregate.create('role-1', {
        name: 'audit-reader',
        description: 'Old description',
        permissions: [PermissionCodeEnum.AUDIT_READ],
      }),
    );

    useCase = new UpdateRoleUseCase(roles, permissions, audit);
  });

  it('throws BadRequestException on a no-op patch', async () => {
    await expect(useCase.execute({ id: 'role-1' })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('throws NotFoundException when the role id does not exist', async () => {
    await expect(
      useCase.execute({ id: 'missing', description: 'whatever' }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('updates the description and leaves permissions untouched', async () => {
    const updated = await useCase.execute({ id: 'role-1', description: 'New description' });
    expect(updated.description).toBe('New description');
    expect(Array.from(updated.permissions)).toEqual([PermissionCodeEnum.AUDIT_READ]);
  });

  it('replaces the permission set when permissionCodes is provided', async () => {
    const updated = await useCase.execute({
      id: 'role-1',
      permissionCodes: [PermissionCodeEnum.IAM_ROLE_EDIT],
    });
    expect(Array.from(updated.permissions)).toEqual([PermissionCodeEnum.IAM_ROLE_EDIT]);
  });

  it('throws BadRequestException on unknown permission codes', async () => {
    await expect(
      useCase.execute({
        id: 'role-1',
        permissionCodes: ['inventory:nope' as PermissionCodeEnum],
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  describe('audit-log publishing', () => {
    it('publishes RolePermissionsReplaced when the permission set changes', async () => {
      const role = await useCase.execute({
        id: 'role-1',
        permissionCodes: [PermissionCodeEnum.IAM_ROLE_EDIT],
        actorId: 'staff-admin-1',
        correlationId: 'cid-role-update',
      });

      expect(audit.published).toHaveLength(1);
      expect(audit.published[0]).toMatchObject({
        name: 'RolePermissionsReplaced',
        actorId: 'staff-admin-1',
        actorKind: 'staff',
        targetId: role.id,
        targetKind: 'role',
        correlationId: 'cid-role-update',
        payload: {
          name: 'audit-reader',
          permissionCodes: [PermissionCodeEnum.IAM_ROLE_EDIT],
          descriptionUpdated: false,
          permissionsReplaced: true,
        },
      });
    });

    it('publishes RolePermissionsReplaced when only the description changes', async () => {
      await useCase.execute({
        id: 'role-1',
        description: 'New description',
        actorId: 'staff-admin-1',
        correlationId: 'cid-role-desc',
      });

      expect(audit.published).toHaveLength(1);
      expect(audit.published[0]).toMatchObject({
        name: 'RolePermissionsReplaced',
        targetId: 'role-1',
        targetKind: 'role',
        correlationId: 'cid-role-desc',
        payload: {
          name: 'audit-reader',
          description: 'New description',
          descriptionUpdated: true,
          permissionsReplaced: false,
        },
      });
    });

    it('does not publish on the no-op patch / not-found branches', async () => {
      await expect(useCase.execute({ id: 'role-1' })).rejects.toBeInstanceOf(BadRequestException);
      expect(audit.published).toEqual([]);
    });
  });
});
