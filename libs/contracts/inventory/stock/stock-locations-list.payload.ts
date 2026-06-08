// RPC payload for `inventory.location.list` (API Gateway → Inventory). Lists the
// stock locations; `activeOnly: true` drops deactivated locations from the
// result (the soft-delete is the `active` flag — ADR-027). `correlationId` is
// optional on the wire (see `IVariantStockGetPayload`).
export interface IStockLocationsListPayload {
  activeOnly?: boolean;
  correlationId?: string;
}
