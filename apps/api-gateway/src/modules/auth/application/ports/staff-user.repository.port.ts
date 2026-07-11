import { StaffUser } from '../../domain';

export const STAFF_USER_REPOSITORY = Symbol('STAFF_USER_REPOSITORY');

// No `softDelete` (ADR-049). Deactivating a staff user means `StaffUser.suspend()` +
// `save` — `status` is what `existsActiveById` gates the JWT on, and it is what
// README §14 names as the seam for the deactivation route that does not exist yet.
// A row-level soft delete was a second, competing mechanism for the same thing, and
// nothing called either.

export interface IStaffUserRepositoryPort {
  findByEmail(email: string): Promise<StaffUser | null>;
  findById(id: string): Promise<StaffUser | null>;
  // Cheap point check for the per-request JWT validator: confirms an *active*
  // (status 'active', not soft-deleted) row exists by id without loading the
  // role/permission graph that `findById` eager-joins.
  existsActiveById(id: string): Promise<boolean>;
  save(user: StaffUser): Promise<StaffUser>;
}
