import { StockLevelView, StockLocationView } from '@retail-inventory-system/contracts';

import { StockLevel, StockLocation } from '../../domain';

// Pure mapping functions from the inventory domain onto the wire views. Kept
// framework-free (no Nest decorators) and shared across the read use cases
// (Query Availability / List Locations) and the write use cases (Receive /
// Adjust, which return the updated per-location level), so each projection
// lives in exactly one place — the catalog `catalog-view.factory.ts` / pricing
// `price-view.factory.ts` precedent (ADR-025).

export const toStockLevelView = (level: StockLevel): StockLevelView => ({
  stockLocationId: level.stockLocationId,
  quantityOnHand: level.quantityOnHand,
  quantityAllocated: level.quantityAllocated,
  quantityReserved: level.quantityReserved,
  // `available` is the domain getter (onHand − allocated − reserved); a
  // cross-location total is the sum of these per-location derived values.
  available: level.available,
  version: level.version,
  updatedAt: level.updatedAt,
});

export const toStockLocationView = (location: StockLocation): StockLocationView => ({
  id: location.id,
  name: location.name,
  code: location.code,
  // The enum values are strings; the wire view carries the plain string — the
  // `StockLocationTypeEnum` is an internal domain concept, not a wire contract
  // (the catalog `*StatusEnum` precedent, ADR-025).
  type: location.type,
  gln: location.gln,
  active: location.active,
});
