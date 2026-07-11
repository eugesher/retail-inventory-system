import { PermissionAggregate } from '../../domain';

export const PERMISSION_REPOSITORY = Symbol('PERMISSION_REPOSITORY');

// `findByCodes` is the only read the module needs: role creation and role edit resolve
// the codes a caller named, and reject the ones that do not resolve. `findAll` used to sit
// beside it with no caller — there is no "list every permission" route, and the enum
// (`PermissionCodeEnum`) is the source of truth for what codes exist, not the table
// (ADR-049).
export interface IPermissionRepositoryPort {
  findByCodes(codes: string[]): Promise<PermissionAggregate[]>;
}
