import { ICorrelationPayload } from '../../microservices';

export interface IReservationReservePayload extends ICorrelationPayload {
  variantId: number;
  stockLocationId?: string;
  quantity: number;
  cartId: string;
}
