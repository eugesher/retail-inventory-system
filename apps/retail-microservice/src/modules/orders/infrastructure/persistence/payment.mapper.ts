import { DeepPartial } from 'typeorm';

import { Payment } from '../../domain';
import { PaymentEntity } from './payment.entity';

export class PaymentMapper {
  // `id` is omitted when null so TypeORM inserts; present so it updates. A payment
  // has no owned children and no `@VersionColumn`, so the whole row maps directly.
  public static toEntity(domain: Payment): DeepPartial<PaymentEntity> {
    const entity: DeepPartial<PaymentEntity> = {
      orderId: domain.orderId,
      amountMinor: domain.amountMinor,
      currency: domain.currency,
      method: domain.method,
      status: domain.status,
      gatewayReference: domain.gatewayReference,
      authorizedAt: domain.authorizedAt,
      capturedAt: domain.capturedAt,
    };

    if (domain.id !== null) {
      entity.id = domain.id;
    }

    return entity;
  }

  public static toDomain(entity: PaymentEntity): Payment {
    return Payment.reconstitute({
      // The BIGINT PK comes back as a number; coerce defensively, like the
      // `order_id` / `amount_minor` BIGINT scalars below (mysql2 returns non-PK
      // BIGINTs as strings).
      id: Number(entity.id),
      orderId: Number(entity.orderId),
      amountMinor: Number(entity.amountMinor),
      currency: entity.currency,
      method: entity.method,
      status: entity.status,
      gatewayReference: entity.gatewayReference,
      authorizedAt: entity.authorizedAt ?? null,
      capturedAt: entity.capturedAt ?? null,
      createdAt: entity.createdAt ?? null,
      updatedAt: entity.updatedAt ?? null,
    });
  }
}
