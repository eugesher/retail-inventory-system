import {
  StockLevelView,
  StockLocationView,
  VariantStockView,
} from '@retail-inventory-system/contracts';

export const INVENTORY_GATEWAY_PORT = Symbol('INVENTORY_GATEWAY_PORT');

// Business-shaped query / command inputs for the gateway inventory port. They
// deliberately omit `correlationId` — that is a transport concern threaded
// separately and stitched onto the wire payload inside the adapter (the same
// split the catalog gateway port follows). `stockLocationIds` mirrors the RPC
// payload field name; the controller maps the HTTP `?locationIds` query onto it.
export interface IGetVariantStockQuery {
  variantId: number;
  stockLocationIds?: string[];
}

export interface IListLocationsQuery {
  activeOnly?: boolean;
}

// Receive Stock command: raise on-hand by a positive `quantity`. `stockLocationId`
// is optional — omit it to target the default warehouse. `actorId` is the staff
// user (the gateway threads it from `@CurrentUser()`).
export interface IReceiveStockCommand {
  variantId: number;
  stockLocationId?: string;
  quantity: number;
  actorId?: string;
}

// Adjust Stock command: apply a signed `quantityDelta` with a mandatory
// `reasonCode`. Same optional `stockLocationId` / `actorId` shape as receive.
export interface IAdjustStockCommand {
  variantId: number;
  stockLocationId?: string;
  quantityDelta: number;
  reasonCode: string;
  actorId?: string;
}

// The gateway-side seam onto the inventory microservice's read + write RPCs
// (`inventory.stock-level.get` / `inventory.location.list` reads;
// `inventory.stock-level.receive` / `inventory.stock-level.adjust` writes). The
// concrete implementation (`InventoryRabbitmqAdapter`) is the only holder of a
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
  // Receive Stock: returns the updated `StockLevelView` for the affected location.
  receiveStock(command: IReceiveStockCommand, correlationId: string): Promise<StockLevelView>;
  // Adjust Stock: returns the updated `StockLevelView`. A below-zero result is a
  // 409 surfaced by the inventory service's domain filter.
  adjustStock(command: IAdjustStockCommand, correlationId: string): Promise<StockLevelView>;
}
