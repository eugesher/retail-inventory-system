import { DeepPartial } from 'typeorm';

import { Refund } from '../../domain';
import { RefundEntity } from './refund.entity';

export class RefundMapper {
  public static toEntity(domain: Refund): DeepPartial<RefundEntity> {
    const entity: DeepPartial<RefundEntity> = {
      orderId: domain.orderId,
      paymentId: domain.paymentId,
      amountMinor: domain.amountMinor,
      currency: domain.currency,
      status: domain.status,
      reason: domain.reason,
      gatewayReference: domain.gatewayReference,
      issuedAt: domain.issuedAt,
    };

    if (domain.id !== null) {
      entity.id = domain.id;
    }

    return entity;
  }

  public static toDomain(entity: RefundEntity): Refund {
    return Refund.reconstitute({
      id: Number(entity.id),
      orderId: Number(entity.orderId),
      paymentId: Number(entity.paymentId),
      amountMinor: Number(entity.amountMinor),
      currency: entity.currency,
      status: entity.status,
      reason: entity.reason,
      gatewayReference: entity.gatewayReference ?? null,
      issuedAt: entity.issuedAt ?? null,
      createdAt: entity.createdAt ?? null,
      updatedAt: entity.updatedAt ?? null,
    });
  }
}
