export * from './infrastructure/persistence/customer.entity';
export * from './infrastructure/persistence/permission.entity';
export * from './infrastructure/persistence/role.entity';
export * from './infrastructure/persistence/staff-user.entity';
export * from './infrastructure/auth.module';

// Aggregates — IAM consumes these to construct (`RoleAggregate.create`) and
// rehydrate Role/Permission/StaffUser instances when calling cross-module
// repositories injected via the tokens below.
export { RoleAggregate } from './domain/role.aggregate';
export { PermissionAggregate } from './domain/permission.aggregate';
export { StaffUser } from './domain/staff-user.model';
export { StaffUserRolesAssignedEvent } from './domain/events/staff-user-roles-assigned.event';
export { StaffUserRoleRevokedEvent } from './domain/events/staff-user-role-revoked.event';

// Repository ports + DI tokens — the IAM module re-uses the auth module's
// adapters rather than re-registering them. Auth re-exports the tokens so
// cross-module consumers (today: `iam`; tomorrow: any admin surface that
// reads/writes auth aggregates) can `@Inject(ROLE_REPOSITORY)` without
// reaching into auth's `application/ports/` deep path.
export { ROLE_REPOSITORY, IRoleRepositoryPort } from './application/ports/role.repository.port';
export {
  PERMISSION_REPOSITORY,
  IPermissionRepositoryPort,
} from './application/ports/permission.repository.port';
export {
  STAFF_USER_REPOSITORY,
  IStaffUserRepositoryPort,
} from './application/ports/staff-user.repository.port';
