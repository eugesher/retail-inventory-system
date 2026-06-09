import { DeepPartial } from 'typeorm';

import { CartLine } from '../../domain';
import { CartEntity } from './cart.entity';
import { CartLineEntity } from './cart-line.entity';

export class CartLineMapper {
  // `cartId` is supplied by the repository (the root's CHAR(36) UUID); a cart
  // line never stands alone. The FK is set through the `cart` relation reference
  // `{ id: cartId }` — TypeORM writes `cart_id` from it without cascading to (or
  // touching) the `cart` table (the `@ManyToOne` carries no cascade). Omit a null
  // id so TypeORM inserts the row; pass the concrete id so an existing line is
  // updated in place.
  public static toEntity(domain: CartLine, cartId: string): DeepPartial<CartLineEntity> {
    const entity: DeepPartial<CartLineEntity> = {
      cart: { id: cartId } as CartEntity,
      variantId: domain.variantId,
      quantity: domain.quantity,
      unitPriceSnapshotMinor: domain.unitPriceSnapshotMinor,
      currencySnapshot: domain.currencySnapshot,
    };

    if (domain.id !== null) {
      entity.id = domain.id;
    }

    return entity;
  }

  public static toDomain(entity: CartLineEntity): CartLine {
    return new CartLine({
      id: entity.id,
      // `variant_id` / `unit_price_snapshot_minor` are BIGINT columns; mysql2
      // returns non-PK BIGINTs as strings, so coerce back to a number (the same
      // reason the stock-level / pricing mappers use `Number(...)`). The BIGINT
      // PK comes back as a number via `@PrimaryGeneratedColumn()`.
      variantId: Number(entity.variantId),
      quantity: entity.quantity,
      unitPriceSnapshotMinor: Number(entity.unitPriceSnapshotMinor),
      currencySnapshot: entity.currencySnapshot,
    });
  }
}
