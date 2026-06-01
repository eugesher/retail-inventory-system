import { PermissionCodeEnum } from '@retail-inventory-system/contracts';

import { RoleAggregate } from '../../../../auth';
import { ListRolesUseCase } from '../list-roles.use-case';
import { InMemoryRoleRepository } from './test-doubles';

describe('ListRolesUseCase', () => {
  let roles: InMemoryRoleRepository;
  let useCase: ListRolesUseCase;

  beforeEach(() => {
    roles = new InMemoryRoleRepository();
    useCase = new ListRolesUseCase(roles);
  });

  it('returns an empty array when no roles exist', async () => {
    expect(await useCase.execute()).toEqual([]);
  });

  it('returns roles sorted by name ASC', async () => {
    roles.seed(
      RoleAggregate.create('id-2', {
        name: 'order-support',
        permissions: [PermissionCodeEnum.ORDER_READ],
      }),
    );
    roles.seed(
      RoleAggregate.create('id-1', { name: 'admin', permissions: [PermissionCodeEnum.AUDIT_READ] }),
    );
    roles.seed(
      RoleAggregate.create('id-3', {
        name: 'catalog-manager',
        permissions: [PermissionCodeEnum.CATALOG_READ],
      }),
    );

    const result = await useCase.execute();
    expect(result.map((r) => r.name)).toEqual(['admin', 'catalog-manager', 'order-support']);
  });
});
