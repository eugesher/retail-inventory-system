import { Customer } from '../../domain';

export const CUSTOMER_ERASURE_WRITER = Symbol('CUSTOMER_ERASURE_WRITER');

export interface ICustomerErasureWriterPort {
  persistErasure(customer: Customer): Promise<void>;
}
