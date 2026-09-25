import { ICorrelationPayload } from '../../microservices';

export interface IAllocationLine {
  variantId: number;
  stockLocationId?: string;
  quantity: number;
}

export interface IReservationAllocatePayload extends ICorrelationPayload {
  cartId: string;
  orderId: number;
  lines: IAllocationLine[];
}
