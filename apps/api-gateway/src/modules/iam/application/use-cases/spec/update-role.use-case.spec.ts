import { BadRequestException, NotFoundException } from '@nestjs/common';

import { PermissionCodeEnum } from '@retail-inventory-system/contracts';

import { PermissionAggregate, RoleAggregate } from '../../../../auth';
import { UpdateRoleUseCase } from '../update-role.use-case';
import { InMemoryPermissionRepository, InMemoryRoleRepository } from './test-doubles';

describe('UpdateRoleUseCase', () => {
  let roles: InMemoryRoleRepository;
  let permissions: InMemoryPermissionRepository;
  let useCase: UpdateRoleUseCase;

  beforeEach(() => {
    roles = new InMemoryRoleRepository();
    permissions = new InMemoryPermissionRepository();
    permissions.seed(PermissionAggregate.create('p1', { code: PermissionCodeEnum.AUDIT_READ }));
    permissions.seed(PermissionAggregate.create('p2', { code: PermissionCodeEnum.IAM_ROLE_EDIT }));
    roles.seed(
      RoleAggregate.create('role-1', {
        name: 'audit-reader',
        description: 'Old description',
        permissions: [PermissionCodeEnum.AUDIT_READ],
      }),
    );

    useCase = new UpdateRoleUseCase(roles, permissions);
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
});
