import { ICorrelationPayload } from '../../../microservices';

// Per-line item of the `inventory.order.confirm` RPC payload. The retail-side
// caller has been retired with the legacy order model; this shape is retained
// only so the inventory `inventory.order.confirm` deprecation stub still
// type-checks (a reserved surface — the whole confirm seam is removed when the
// inventory-reservation capability lands, see
// docs/adr/027-stocklevel-running-totals-and-stocklocation.md). It was inlined
// here when the legacy retail `IOrderProductConfirm` / `OrderProductStatusEnum`
// it used to import were deleted, so `statusId` is now a plain string rather
// than the former enum.
export interface IProductStockOrderConfirmItem {
  id: number;
  productId: number;
  statusId: string;
}

export interface IProductStockOrderConfirmPayload extends ICorrelationPayload {
  products: IProductStockOrderConfirmItem[];
}
