import { ICorrelationPayload } from '../../microservices';

export interface IRetailCartLineRemovedEvent extends ICorrelationPayload {
  cartId: string;
  lineId: number;
  eventVersion: 'v1';
  occurredAt: string;
}
