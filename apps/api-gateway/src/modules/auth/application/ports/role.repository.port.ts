import { PermissionCodeEnum } from '@retail-inventory-system/contracts';

import { RoleAggregate } from '../../domain';

export const ROLE_REPOSITORY = Symbol('ROLE_REPOSITORY');

export interface IRoleRepositoryPort {
  findById(id: string): Promise<RoleAggregate | null>;
  findByName(name: string): Promise<RoleAggregate | null>;
  findAllByNames(names: string[]): Promise<RoleAggregate[]>;
  findAll(): Promise<RoleAggregate[]>;
  save(role: RoleAggregate): Promise<RoleAggregate>;
  update(role: RoleAggregate, codes?: PermissionCodeEnum[]): Promise<RoleAggregate>;
}
