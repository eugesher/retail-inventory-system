export * from './auth.module';

// Repository ports + DI tokens — the IAM module re-uses the auth module's
// adapters rather than re-registering them. Auth re-exports the tokens so
// cross-module consumers (today: `iam`; tomorrow: any admin surface that
// reads/writes auth aggregates) can `@Inject(ROLE_REPOSITORY)` without
// reaching into auth's `application/ports/` deep path.
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

// Aggregates — IAM consumes these to construct (`RoleAggregate.create`) and
// rehydrate Role/Permission/StaffUser instances when calling cross-module
// repositories injected via the tokens below. `ConsentRecord` rides along for
// the consent Record/Read use cases + the erase writer (later consent work).
export { ConsentRecord, RoleAggregate, PermissionAggregate, StaffUser } from './domain';
export { StaffUserRolesAssignedEvent, StaffUserRoleRevokedEvent } from './domain/events';
