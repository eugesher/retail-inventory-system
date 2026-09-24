import { Fulfillment } from '../../domain';
import { ITransactionScope } from '@retail-inventory-system/ddd';

export const FULFILLMENT_REPOSITORY = Symbol('FULFILLMENT_REPOSITORY');

export interface IFulfillmentRepositoryPort {
  save(fulfillment: Fulfillment, scope?: ITransactionScope): Promise<Fulfillment>;
  findById(id: number, scope?: ITransactionScope): Promise<Fulfillment | null>;
  findByIdForUpdate(id: number, scope: ITransactionScope): Promise<Fulfillment | null>;
  listByOrderId(orderId: number, scope?: ITransactionScope): Promise<Fulfillment[]>;
}
