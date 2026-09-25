import { PermissionAggregate } from '../../domain';

export const PERMISSION_REPOSITORY = Symbol('PERMISSION_REPOSITORY');

export interface IPermissionRepositoryPort {
  findByCodes(codes: string[]): Promise<PermissionAggregate[]>;
}
