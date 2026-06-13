import { DeepPartial } from 'typeorm';

import { Reservation } from '../../domain';
import { ReservationEntity } from './reservation.entity';

export class ReservationMapper {
  public static toDomain(entity: ReservationEntity): Reservation {
    return Reservation.reconstitute({
      id: entity.id,
      // `variant_id` is a BIGINT column; the mysql2 driver returns non-PK BIGINTs
      // as strings, so coerce back to a number (the `StockLevelMapper` / pricing
      // precedent). The CHAR(36) PK is already a string.
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
    // `id` is always concrete on a live hold (app-generated at `create`), so it is
    // always written — TypeORM preloads by it (INSERT when absent, UPDATE when
    // present). `version` is owned by TypeORM's `@VersionColumn` and is
    // intentionally NOT written here, so the managed optimistic-lock token is never
    // raced by a manual value. `createdAt` / `updatedAt` are DB-managed.
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
