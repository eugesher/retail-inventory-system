import { StaffUser } from '../../domain/staff-user.model';

export const STAFF_USER_REPOSITORY = Symbol('STAFF_USER_REPOSITORY');

export interface IStaffUserRepositoryPort {
  findByEmail(email: string): Promise<StaffUser | null>;
  findById(id: string): Promise<StaffUser | null>;
  save(user: StaffUser): Promise<StaffUser>;
  softDelete(id: string): Promise<void>;
}
