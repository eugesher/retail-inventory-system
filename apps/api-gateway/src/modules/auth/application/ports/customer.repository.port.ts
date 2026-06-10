import { Customer } from '../../domain';

export const CUSTOMER_REPOSITORY = Symbol('CUSTOMER_REPOSITORY');

export interface ICustomerRepositoryPort {
  findByEmail(email: string): Promise<Customer | null>;
  findById(id: string): Promise<Customer | null>;
  // Cheap point check for the per-request JWT validator: confirms an
  // authenticatable row exists by id without rehydrating the aggregate. A guest
  // is authenticatable (`status IN ('active','guest')`) — only suspended/deleted
  // are barred (ADR-028 §1, Q1/Q7). A guest is a real logged-in-able row.
  existsAuthenticatableById(id: string): Promise<boolean>;
  save(customer: Customer): Promise<Customer>;
}
