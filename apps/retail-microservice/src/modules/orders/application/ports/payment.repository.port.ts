import { Payment } from '../../domain';
import { ITransactionScope } from '@retail-inventory-system/ddd';

export const PAYMENT_REPOSITORY = Symbol('PAYMENT_REPOSITORY');

export interface IPaymentRepositoryPort {
  save(payment: Payment, scope?: ITransactionScope): Promise<Payment>;
  findById(id: number): Promise<Payment | null>;
  findByOrderId(orderId: number, scope?: ITransactionScope): Promise<Payment | null>;
  findByOrderIdForUpdate(orderId: number, scope: ITransactionScope): Promise<Payment | null>;
  listStaleCaptureClaims(olderThan: Date): Promise<Payment[]>;
}
