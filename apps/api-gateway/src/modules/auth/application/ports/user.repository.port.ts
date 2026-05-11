import { User } from '../../domain/user.model';

export const USER_REPOSITORY = Symbol('USER_REPOSITORY');

export interface IUserRepositoryPort {
  findByEmail(email: string): Promise<User | null>;
  findById(id: string): Promise<User | null>;
  save(user: User): Promise<User>;
  softDelete(id: string): Promise<void>;
}
