import { DeepPartial } from 'typeorm';

import { Cart } from '../../domain';
import { CartEntity } from './cart.entity';
import { CartLineMapper } from './cart-line.mapper';

export class CartMapper {
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
      version: Number(entity.version),
      lines: (entity.lines ?? []).map((line) => CartLineMapper.toDomain(line)),
      createdAt: entity.createdAt ?? null,
      updatedAt: entity.updatedAt ?? null,
    });
  }
}
