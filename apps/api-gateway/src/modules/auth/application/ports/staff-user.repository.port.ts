import { StaffUser } from '../../domain';

export const STAFF_USER_REPOSITORY = Symbol('STAFF_USER_REPOSITORY');

export interface IStaffUserRepositoryPort {
  findByEmail(email: string): Promise<StaffUser | null>;
  findById(id: string): Promise<StaffUser | null>;
  existsActiveById(id: string): Promise<boolean>;
  save(user: StaffUser): Promise<StaffUser>;
}
