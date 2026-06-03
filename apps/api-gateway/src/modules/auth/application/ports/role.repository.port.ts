import { PermissionCodeEnum } from '@retail-inventory-system/contracts';

import { RoleAggregate } from '../../domain';

export const ROLE_REPOSITORY = Symbol('ROLE_REPOSITORY');

export interface IRoleRepositoryPort {
  findById(id: string): Promise<RoleAggregate | null>;
  findByName(name: string): Promise<RoleAggregate | null>;
  findAllByNames(names: string[]): Promise<RoleAggregate[]>;
  findAll(): Promise<RoleAggregate[]>;
  save(role: RoleAggregate): Promise<RoleAggregate>;
  // Atomically persists edits to an existing role in a single transaction:
  // always writes the scalar columns (description) from the aggregate, and —
  // when `codes` is supplied — replaces the `role_permissions` set in the same
  // transaction so description and permissions can never commit independently
  // and the join table is never observed empty mid-edit. Pass `codes ===
  // undefined` to leave the permission set untouched (a description-only patch,
  // which then skips the join rewrite entirely). Returns the rehydrated
  // aggregate with the post-update state.
  update(role: RoleAggregate, codes?: PermissionCodeEnum[]): Promise<RoleAggregate>;
}
