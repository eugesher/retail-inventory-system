import { StaffUser } from '../../domain';

export const STAFF_USER_REPOSITORY = Symbol('STAFF_USER_REPOSITORY');

export interface IStaffUserRepositoryPort {
  findByEmail(email: string): Promise<StaffUser | null>;
  findById(id: string): Promise<StaffUser | null>;
  // Cheap point check for the per-request JWT validator: confirms an *active*
  // (status 'active', not soft-deleted) row exists by id without loading the
  // role/permission graph that `findById` eager-joins.
  existsActiveById(id: string): Promise<boolean>;
  save(user: StaffUser): Promise<StaffUser>;
  softDelete(id: string): Promise<void>;
}
