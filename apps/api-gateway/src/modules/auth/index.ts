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
// the consent Record/Read use cases + the erase writer.
export { ConsentRecord, RoleAggregate, PermissionAggregate, StaffUser } from './domain';
export { StaffUserRolesAssignedEvent, StaffUserRoleRevokedEvent } from './domain/events';

// Use cases the admin shells inject. The `customer-admin` module fronts the
// admin consent-read (`ReadConsentUseCase`, owner-or-staff, `isStaff: true`) and
// the tombstone erase (`EraseCustomerUseCase`); both are provided + exported by
// `auth.module.ts`. Exposing them through the module-root barrel is the sanctioned
// cross-module seam — the `iam` module reaches auth's aggregates the same way (the
// deep `application/use-cases` path is blocked by the boundaries lint). The result
// type rides along so the admin controller can annotate its response.
export { ReadConsentUseCase, EraseCustomerUseCase } from './application/use-cases';
export type { IEraseCustomerResult } from './application/use-cases';
