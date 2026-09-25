import { ICorrelationPayload } from '../../microservices';
import { IAllocationLine } from './reservation-allocate.payload';

export interface IAllocationCancelPayload extends ICorrelationPayload {
  orderId: number;
  lines: IAllocationLine[];
  reason?: string;
  actorId?: string;
  operationKey: string;
}
