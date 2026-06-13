import { ICorrelationPayload } from '../../microservices';

// RPC payload for `inventory.reservation.reserve` (Gateway / Retail → Inventory).
// Reserve holds stock for one variant at one location against a cart (ADR-030).
//
// `quantity` is the **absolute** target for the `(cartId, variantId,
// stockLocationId)` triple, NOT a delta: a re-reserve of the same triple sets the
// hold to this quantity (the use case applies only the difference to
// `StockLevel.quantityReserved`), so the operation is idempotent-by-absolute-
// quantity. `stockLocationId` is optional — omit it to target the default
// warehouse (`INVENTORY_DEFAULT_STOCK_LOCATION`). It extends `ICorrelationPayload`
// (the correlation id is always threaded by the gateway on this command path);
// this interface doubles as the `ReserveStockUseCase` input shape.
export interface IReservationReservePayload extends ICorrelationPayload {
  variantId: number;
  stockLocationId?: string;
  quantity: number;
  cartId: string;
}
