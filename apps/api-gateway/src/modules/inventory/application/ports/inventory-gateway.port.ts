import { StockLocationView, VariantStockView } from '@retail-inventory-system/contracts';

export const INVENTORY_GATEWAY_PORT = Symbol('INVENTORY_GATEWAY_PORT');

// Business-shaped query inputs for the gateway inventory port. They deliberately
// omit `correlationId` — that is a transport concern threaded separately and
// stitched onto the wire payload inside the adapter (the same split the catalog
// gateway port follows). `stockLocationIds` mirrors the RPC payload field name;
// the controller maps the HTTP `?locationIds` query onto it.
export interface IGetVariantStockQuery {
  variantId: number;
  stockLocationIds?: string[];
}

export interface IListLocationsQuery {
  activeOnly?: boolean;
}

// The gateway-side seam onto the inventory microservice's two read RPCs
// (`inventory.stock-level.get` + `inventory.location.list`). The concrete
// implementation (`InventoryRabbitmqAdapter`) is the only holder of a
// `ClientProxy`; use cases and the controller depend on this interface (ADR-009).
// Methods return the wire response DTOs from `lib-contracts` so the HTTP layer
// surfaces the inventory service's own view shapes unchanged.
export interface IInventoryGatewayPort {
  // Per-variant availability projection: each location's `StockLevel` slice plus
  // the cross-location totals. Omitting `stockLocationIds` aggregates across every
  // location; passing a subset scopes the answer to those locations.
  getVariantStock(query: IGetVariantStockQuery, correlationId: string): Promise<VariantStockView>;
  // The stock-location list. `activeOnly: true` drops deactivated locations
  // (soft-delete is the `active` flag — ADR-027).
  listLocations(query: IListLocationsQuery, correlationId: string): Promise<StockLocationView[]>;
}
