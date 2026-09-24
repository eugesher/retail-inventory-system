import { StockLevelView, StockLocationView } from '@retail-inventory-system/contracts';

import { StockLevel, StockLocation } from '../../domain';

export const toStockLevelView = (level: StockLevel): StockLevelView => ({
  stockLocationId: level.stockLocationId,
  quantityOnHand: level.quantityOnHand,
  quantityAllocated: level.quantityAllocated,
  quantityReserved: level.quantityReserved,
  available: level.available,
  version: level.version,
  updatedAt: level.updatedAt,
});

export const toStockLocationView = (location: StockLocation): StockLocationView => ({
  id: location.id,
  name: location.name,
  code: location.code,
  type: location.type,
  gln: location.gln,
  active: location.active,
});
