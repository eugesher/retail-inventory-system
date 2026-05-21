import { StockItem } from '../../domain';
import { ProductStock } from './product-stock.entity';

interface IStockItemRawAggregate {
  productId: number;
  storageId: string;
  quantity: number;
  updatedAt?: Date | null;
}

export class StockItemMapper {
  // Both paths clamp at zero: aggregates net signed deltas and single
  // ledger rows can themselves be signed, but the StockItem invariant
  // requires `quantity >= 0`.
  public static toDomainFromAggregate(raw: IStockItemRawAggregate): StockItem {
    return new StockItem({
      productId: raw.productId,
      storageId: raw.storageId,
      quantity: Math.max(0, raw.quantity),
      updatedAt: raw.updatedAt ?? null,
    });
  }

  public static toDomain(entity: ProductStock): StockItem {
    return new StockItem({
      productId: entity.productId,
      storageId: entity.storageId,
      quantity: Math.max(0, entity.quantity),
      updatedAt: entity.createdAt ?? null,
    });
  }
}
