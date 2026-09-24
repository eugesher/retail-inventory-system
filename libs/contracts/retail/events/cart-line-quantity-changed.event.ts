import { ICorrelationPayload } from '../../microservices';

export interface IRetailCartLineQuantityChangedEvent extends ICorrelationPayload {
  cartId: string;
  lineId: number;
  quantity: number;
  eventVersion: 'v1';
  occurredAt: string;
}
