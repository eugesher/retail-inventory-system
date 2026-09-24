import { DeepPartial } from 'typeorm';

import { Reservation } from '../../domain';
import { ReservationEntity } from './reservation.entity';

export class ReservationMapper {
  public static toDomain(entity: ReservationEntity): Reservation {
    return Reservation.reconstitute({
      id: entity.id,
      variantId: Number(entity.variantId),
      stockLocationId: entity.stockLocationId,
      quantity: entity.quantity,
      cartId: entity.cartId,
      expiresAt: entity.expiresAt,
      status: entity.status,
      version: Number(entity.version),
      createdAt: entity.createdAt ?? null,
      updatedAt: entity.updatedAt ?? null,
    });
  }

  public static toEntity(domain: Reservation): DeepPartial<ReservationEntity> {
    return {
      id: domain.id ?? undefined,
      variantId: domain.variantId,
      stockLocationId: domain.stockLocationId,
      quantity: domain.quantity,
      cartId: domain.cartId,
      expiresAt: domain.expiresAt,
      status: domain.status,
    };
  }
}
