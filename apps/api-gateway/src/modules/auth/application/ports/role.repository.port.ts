import { PermissionCodeEnum } from '@retail-inventory-system/contracts';

import { RoleAggregate } from '../../domain/role.aggregate';

export const ROLE_REPOSITORY = Symbol('ROLE_REPOSITORY');

export interface IRoleRepositoryPort {
  findById(id: string): Promise<RoleAggregate | null>;
  findByName(name: string): Promise<RoleAggregate | null>;
  findAllByNames(names: string[]): Promise<RoleAggregate[]>;
  findAll(): Promise<RoleAggregate[]>;
  save(role: RoleAggregate): Promise<RoleAggregate>;
  // Atomic replace-permission-set: clears the `role_permissions` rows for
  // this role and inserts the new bindings in a single transaction so the
  // join table is never observed empty mid-edit. Returns the rehydrated
  // aggregate with the post-replace permission set.
  replacePermissions(role: RoleAggregate, codes: PermissionCodeEnum[]): Promise<RoleAggregate>;
}
