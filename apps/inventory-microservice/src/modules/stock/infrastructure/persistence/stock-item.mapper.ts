import { StockItem } from '../../domain';
import { ProductStock } from './product-stock.entity';

interface IStockItemRawAggregate {
  productId: number;
  storageId: string;
  quantity: number;
  updatedAt?: Date | null;
}

// Aggregated rows from `product_stock` are net of all signed deltas — the
// resulting non-negative quantity is what becomes the StockItem's
// `quantity`. The entity itself is a single ledger row (not the aggregate),
// so the entity → domain mapping is reserved for places where we materialize
// a single row as a StockItem with quantity=delta; the aggregate path uses
// `toDomainFromAggregate` below.
export class StockItemMapper {
  public static toDomainFromAggregate(raw: IStockItemRawAggregate): StockItem {
    return new StockItem({
      productId: raw.productId,
      storageId: raw.storageId,
      quantity: Math.max(0, raw.quantity),
      updatedAt: raw.updatedAt ?? null,
    });
  }

  public static toDomain(entity: ProductStock): StockItem {
    // Single ledger rows can be signed — clamp at zero when materializing
    // as a StockItem so the aggregate-invariant (`quantity >= 0`) holds.
    // Use the aggregate path for queries; this branch exists for the
    // single-row case (e.g. lookups by ledger row id).
    return new StockItem({
      productId: entity.productId,
      storageId: entity.storageId,
      quantity: Math.max(0, entity.quantity),
      updatedAt: entity.createdAt ?? null,
    });
  }
}
