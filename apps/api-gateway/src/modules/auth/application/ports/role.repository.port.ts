import { RoleAggregate } from '../../domain/role.aggregate';

export const ROLE_REPOSITORY = Symbol('ROLE_REPOSITORY');

export interface IRoleRepositoryPort {
  findByName(name: string): Promise<RoleAggregate | null>;
  findAllByNames(names: string[]): Promise<RoleAggregate[]>;
  findAll(): Promise<RoleAggregate[]>;
  save(role: RoleAggregate): Promise<RoleAggregate>;
}
