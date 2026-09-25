import { DeepPartial } from 'typeorm';

import { CartLine } from '../../domain';
import { CartEntity } from './cart.entity';
import { CartLineEntity } from './cart-line.entity';

export class CartLineMapper {
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
      variantId: Number(entity.variantId),
      quantity: entity.quantity,
      unitPriceSnapshotMinor: Number(entity.unitPriceSnapshotMinor),
      currencySnapshot: entity.currencySnapshot,
    });
  }
}
