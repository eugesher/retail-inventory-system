export * from './auth.module';

export {
  CONSENT_RECORD_REPOSITORY,
  IConsentRecordRepositoryPort,
  IPermissionRepositoryPort,
  IRoleRepositoryPort,
  IStaffUserRepositoryPort,
  PERMISSION_REPOSITORY,
  ROLE_REPOSITORY,
  STAFF_USER_REPOSITORY,
} from './application/ports';

export { ConsentRecord, RoleAggregate, PermissionAggregate, StaffUser } from './domain';
export { StaffUserRolesAssignedEvent, StaffUserRoleRevokedEvent } from './domain/events';

export {
  ReadConsentUseCase,
  EraseCustomerUseCase,
  RegisterStaffUserUseCase,
} from './application/use-cases';
export type { IEraseCustomerResult } from './application/use-cases';
