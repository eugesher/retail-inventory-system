import { Customer } from '../../domain';

export const CUSTOMER_REPOSITORY = Symbol('CUSTOMER_REPOSITORY');

export interface ICustomerRepositoryPort {
  findByEmail(email: string): Promise<Customer | null>;
  findById(id: string): Promise<Customer | null>;
  // Cheap point check for the per-request JWT validator: confirms an active
  // row exists by id without rehydrating the aggregate.
  existsActiveById(id: string): Promise<boolean>;
  save(customer: Customer): Promise<Customer>;
}
