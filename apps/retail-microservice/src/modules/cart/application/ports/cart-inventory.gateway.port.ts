import {
  IReservationReleasePayload,
  IReservationReleaseResult,
  IReservationReservePayload,
  ReservationView,
} from '@retail-inventory-system/contracts';

export const CART_INVENTORY_GATEWAY = Symbol('CART_INVENTORY_GATEWAY');

export interface ICartInventoryGatewayPort {
  reserveStock(payload: IReservationReservePayload): Promise<ReservationView>;
  releaseStock(payload: IReservationReleasePayload): Promise<IReservationReleaseResult>;
}
