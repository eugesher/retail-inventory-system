import { ICorrelationPayload } from '../../microservices';

export interface IRetailCartLineAddedEvent extends ICorrelationPayload {
  cartId: string;
  variantId: number;
  quantity: number;
  eventVersion: 'v1';
  occurredAt: string;
}
