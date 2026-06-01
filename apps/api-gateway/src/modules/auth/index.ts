export * from './auth.module';

// Repository ports + DI tokens — the IAM module re-uses the auth module's
// adapters rather than re-registering them. Auth re-exports the tokens so
// cross-module consumers (today: `iam`; tomorrow: any admin surface that
// reads/writes auth aggregates) can `@Inject(ROLE_REPOSITORY)` without
// reaching into auth's `application/ports/` deep path.
export {
  IPermissionRepositoryPort,
  IRoleRepositoryPort,
  IStaffUserRepositoryPort,
  PERMISSION_REPOSITORY,
  ROLE_REPOSITORY,
  STAFF_USER_REPOSITORY,
} from './application/ports';

// Aggregates — IAM consumes these to construct (`RoleAggregate.create`) and
// rehydrate Role/Permission/StaffUser instances when calling cross-module
// repositories injected via the tokens below.
export { RoleAggregate, PermissionAggregate, StaffUser } from './domain';
export { StaffUserRolesAssignedEvent, StaffUserRoleRevokedEvent } from './domain/events';
