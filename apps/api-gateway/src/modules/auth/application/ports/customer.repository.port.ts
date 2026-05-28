import { Customer } from '../../domain/customer.model';

export const CUSTOMER_REPOSITORY = Symbol('CUSTOMER_REPOSITORY');

export interface ICustomerRepositoryPort {
  findByEmail(email: string): Promise<Customer | null>;
  findById(id: string): Promise<Customer | null>;
  save(customer: Customer): Promise<Customer>;
}
