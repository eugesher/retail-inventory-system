import { Refund } from '../../domain';
import { ITransactionScope } from '@retail-inventory-system/ddd';

export const REFUND_REPOSITORY = Symbol('REFUND_REPOSITORY');

export interface IRefundRepositoryPort {
  save(refund: Refund, scope?: ITransactionScope): Promise<Refund>;
  findByOrderId(orderId: number): Promise<Refund[]>;
  findByPaymentId(paymentId: number, scope?: ITransactionScope): Promise<Refund[]>;
}
