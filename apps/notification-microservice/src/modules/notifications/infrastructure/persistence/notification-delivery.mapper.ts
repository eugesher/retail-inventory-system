import { DeepPartial } from 'typeorm';

import { NotificationDelivery } from '../../domain';
import { NotificationDeliveryEntity } from './notification-delivery.entity';

export class NotificationDeliveryMapper {
  public static toEntity(domain: NotificationDelivery): DeepPartial<NotificationDeliveryEntity> {
    const entity: DeepPartial<NotificationDeliveryEntity> = {
      templateId: domain.templateId,
      recipientCustomerId: domain.recipientCustomerId,
      recipientAddress: domain.recipientAddress,
      channel: domain.channel,
      eventReferenceType: domain.eventReferenceType,
      eventReferenceId: domain.eventReferenceId,
      status: domain.status,
      attemptCount: domain.attemptCount,
      lastAttemptAt: domain.lastAttemptAt,
      failureReason: domain.failureReason,
      renderedSubject: domain.renderedSubject,
      renderedBody: domain.renderedBody,
      correlationId: domain.correlationId,
    };

    if (domain.id !== null) {
      entity.id = domain.id;
    }

    return entity;
  }

  public static toDomain(entity: NotificationDeliveryEntity): NotificationDelivery {
    return NotificationDelivery.reconstitute({
      id: Number(entity.id),
      templateId: Number(entity.templateId),
      recipientCustomerId: entity.recipientCustomerId ?? null,
      recipientAddress: entity.recipientAddress,
      channel: entity.channel,
      eventReferenceType: entity.eventReferenceType,
      eventReferenceId: entity.eventReferenceId,
      status: entity.status,
      attemptCount: Number(entity.attemptCount),
      lastAttemptAt: entity.lastAttemptAt ?? null,
      failureReason: entity.failureReason ?? null,
      renderedSubject: entity.renderedSubject ?? null,
      renderedBody: entity.renderedBody,
      correlationId: entity.correlationId,
      createdAt: entity.createdAt ?? null,
      updatedAt: entity.updatedAt ?? null,
    });
  }
}
