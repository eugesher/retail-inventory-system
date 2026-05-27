import { PermissionAggregate } from '../../domain/permission.aggregate';

export const PERMISSION_REPOSITORY = Symbol('PERMISSION_REPOSITORY');

export interface IPermissionRepositoryPort {
  findAll(): Promise<PermissionAggregate[]>;
  findByCodes(codes: string[]): Promise<PermissionAggregate[]>;
}
