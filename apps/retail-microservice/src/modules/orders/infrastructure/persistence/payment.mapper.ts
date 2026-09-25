import { DeepPartial } from 'typeorm';

import { Payment } from '../../domain';
import { PaymentEntity } from './payment.entity';

export class PaymentMapper {
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
      flaggedForRefund: domain.flaggedForRefund,
      refundedAmountMinor: domain.refundedAmountMinor,
    };

    if (domain.id !== null) {
      entity.id = domain.id;
    }

    return entity;
  }

  public static toDomain(entity: PaymentEntity): Payment {
    return Payment.reconstitute({
      id: Number(entity.id),
      orderId: Number(entity.orderId),
      amountMinor: Number(entity.amountMinor),
      currency: entity.currency,
      method: entity.method,
      status: entity.status,
      gatewayReference: entity.gatewayReference,
      authorizedAt: entity.authorizedAt ?? null,
      capturedAt: entity.capturedAt ?? null,
      flaggedForRefund: entity.flaggedForRefund ?? false,
      refundedAmountMinor: Number(entity.refundedAmountMinor ?? 0),
      createdAt: entity.createdAt ?? null,
      updatedAt: entity.updatedAt ?? null,
    });
  }
}
