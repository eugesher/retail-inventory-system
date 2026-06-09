import { DeepPartial } from 'typeorm';

import { Cart } from '../../domain';
import { CartEntity } from './cart.entity';
import { CartLineMapper } from './cart-line.mapper';

export class CartMapper {
  // Maps the root only — lines are persisted explicitly by the repository (root
  // save → orphan reconciliation → line save), so this partial carries no `lines`
  // array. `id` is the caller-assigned UUID and is always present on a save.
  // `version` is intentionally NOT written — TypeORM's `@VersionColumn` owns the
  // persisted value (the same omission `StockLevelMapper` makes), so the managed
  // optimistic-lock token is never raced by a manual value.
  public static toEntity(domain: Cart): DeepPartial<CartEntity> {
    return {
      id: domain.id ?? undefined,
      customerId: domain.customerId,
      currency: domain.currency,
      status: domain.status,
      expiresAt: domain.expiresAt,
    };
  }

  public static toDomain(entity: CartEntity): Cart {
    return Cart.reconstitute({
      id: entity.id,
      customerId: entity.customerId,
      currency: entity.currency,
      status: entity.status,
      expiresAt: entity.expiresAt ?? null,
      // `version` is INT, returned as a number; coerce defensively for parity with
      // the BIGINT coercions in the line mapper.
      version: Number(entity.version),
      lines: (entity.lines ?? []).map((line) => CartLineMapper.toDomain(line)),
      createdAt: entity.createdAt ?? null,
      updatedAt: entity.updatedAt ?? null,
    });
  }
}
