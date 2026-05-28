import { BadRequestException, ConflictException } from '@nestjs/common';

import { PermissionCodeEnum } from '@retail-inventory-system/contracts';

import { PermissionAggregate, RoleAggregate } from '../../../../auth';
import { CreateRoleUseCase } from '../create-role.use-case';
import { InMemoryPermissionRepository, InMemoryRoleRepository } from './test-doubles';

describe('CreateRoleUseCase', () => {
  let roles: InMemoryRoleRepository;
  let permissions: InMemoryPermissionRepository;
  let useCase: CreateRoleUseCase;

  beforeEach(() => {
    roles = new InMemoryRoleRepository();
    permissions = new InMemoryPermissionRepository();

    permissions.seed(PermissionAggregate.create('p1', { code: PermissionCodeEnum.AUDIT_READ }));
    permissions.seed(PermissionAggregate.create('p2', { code: PermissionCodeEnum.IAM_ROLE_EDIT }));

    useCase = new CreateRoleUseCase(roles, permissions);
  });

  it('persists a new role with the bound permissions', async () => {
    const role = await useCase.execute({
      name: 'audit-reader',
      description: 'Read-only auditor',
      permissionCodes: [PermissionCodeEnum.AUDIT_READ],
    });

    expect(role.name).toBe('audit-reader');
    expect(role.description).toBe('Read-only auditor');
    expect(Array.from(role.permissions)).toEqual([PermissionCodeEnum.AUDIT_READ]);
  });

  it('throws ConflictException when the name already exists', async () => {
    roles.seed(RoleAggregate.create('existing-id', { name: 'audit-reader', permissions: [] }));

    await expect(
      useCase.execute({
        name: 'audit-reader',
        permissionCodes: [PermissionCodeEnum.AUDIT_READ],
      }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('throws BadRequestException listing unknown permission codes', async () => {
    let captured: BadRequestException | undefined;
    try {
      await useCase.execute({
        name: 'bogus',
        permissionCodes: [PermissionCodeEnum.AUDIT_READ, 'inventory:nope' as PermissionCodeEnum],
      });
    } catch (err) {
      captured = err as BadRequestException;
    }
    expect(captured).toBeInstanceOf(BadRequestException);
    expect(captured?.message).toContain('inventory:nope');
  });
});
