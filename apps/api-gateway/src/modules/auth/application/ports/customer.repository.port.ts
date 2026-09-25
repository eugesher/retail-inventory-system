import { Customer } from '../../domain';

export const CUSTOMER_REPOSITORY = Symbol('CUSTOMER_REPOSITORY');

export interface ICustomerRepositoryPort {
  findByEmail(email: string): Promise<Customer | null>;
  findById(id: string): Promise<Customer | null>;
  existsAuthenticatableById(id: string): Promise<boolean>;
  save(customer: Customer): Promise<Customer>;
}
