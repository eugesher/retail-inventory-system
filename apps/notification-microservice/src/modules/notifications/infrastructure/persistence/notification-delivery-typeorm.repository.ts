import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { FindOptionsWhere, LessThan, Repository } from 'typeorm';

import {
  NotificationChannelEnum,
  NotificationDeliveryStatusEnum,
} from '@retail-inventory-system/contracts';

import {
  INotificationDeliveryListFilter,
  INotificationDeliveryPage,
  INotificationDeliveryPageRequest,
  INotificationDeliveryRepositoryPort,
} from '../../application/ports';
import { NotificationDelivery } from '../../domain';
import { isDuplicateEntryError } from './mysql-error.util';
import { NotificationDeliveryEntity } from './notification-delivery.entity';
import { NotificationDeliveryMapper } from './notification-delivery.mapper';

@Injectable()
export class NotificationDeliveryTypeormRepository implements INotificationDeliveryRepositoryPort {
  constructor(
    @InjectRepository(NotificationDeliveryEntity)
    private readonly deliveryRepository: Repository<NotificationDeliveryEntity>,
  ) {}

  public async save(delivery: NotificationDelivery): Promise<NotificationDelivery> {
    try {
      const saved = await this.deliveryRepository.save(
        NotificationDeliveryMapper.toEntity(delivery),
      );
      const reloaded = await this.deliveryRepository.findOne({ where: { id: Number(saved.id) } });
      if (!reloaded) {
        throw new Error(
          `NotificationDeliveryTypeormRepository.save: delivery ${saved.id} vanished after commit`,
        );
      }
      return NotificationDeliveryMapper.toDomain(reloaded);
    } catch (error) {
      if (isDuplicateEntryError(error) && delivery.recipientCustomerId !== null) {
        const existing = await this.findByDedupeKey(
          delivery.templateId,
          delivery.eventReferenceType,
          delivery.eventReferenceId,
          delivery.channel,
          delivery.recipientCustomerId,
        );
        if (existing) {
          return existing;
        }
      }
      throw error;
    }
  }

  public async findById(id: number): Promise<NotificationDelivery | null> {
    const entity = await this.deliveryRepository.findOne({ where: { id } });
    return entity ? NotificationDeliveryMapper.toDomain(entity) : null;
  }

  public async findByDedupeKey(
    templateId: number,
    eventReferenceType: string,
    eventReferenceId: string,
    channel: NotificationChannelEnum,
    recipientCustomerId: string,
  ): Promise<NotificationDelivery | null> {
    const entity = await this.deliveryRepository.findOne({
      where: { templateId, eventReferenceType, eventReferenceId, channel, recipientCustomerId },
    });
    return entity ? NotificationDeliveryMapper.toDomain(entity) : null;
  }

  public async list(
    filter: INotificationDeliveryListFilter,
    page: INotificationDeliveryPageRequest,
  ): Promise<INotificationDeliveryPage> {
    const where: FindOptionsWhere<NotificationDeliveryEntity> = {};
    if (filter.status !== undefined) {
      where.status = filter.status;
    }
    if (filter.channel !== undefined) {
      where.channel = filter.channel;
    }
    if (filter.eventReferenceType !== undefined) {
      where.eventReferenceType = filter.eventReferenceType;
    }
    if (filter.eventReferenceId !== undefined) {
      where.eventReferenceId = filter.eventReferenceId;
    }
    if (filter.recipientCustomerId !== undefined) {
      where.recipientCustomerId = filter.recipientCustomerId;
    }

    const [entities, total] = await this.deliveryRepository.findAndCount({
      where,
      order: { createdAt: 'DESC', id: 'DESC' },
      skip: (page.page - 1) * page.size,
      take: page.size,
    });

    return {
      items: entities.map((entity) => NotificationDeliveryMapper.toDomain(entity)),
      total,
      page: page.page,
      size: page.size,
    };
  }

  public async listRetryable(
    maxAttempts: number,
    limit: number,
    queuedStaleBefore: Date,
  ): Promise<NotificationDelivery[]> {
    const entities = await this.deliveryRepository.find({
      where: [
        {
          status: NotificationDeliveryStatusEnum.FAILED,
          attemptCount: LessThan(maxAttempts),
        },
        {
          status: NotificationDeliveryStatusEnum.QUEUED,
          createdAt: LessThan(queuedStaleBefore),
        },
      ],
      order: { lastAttemptAt: 'ASC', id: 'ASC' },
      take: limit,
    });

    return entities.map((entity) => NotificationDeliveryMapper.toDomain(entity));
  }

  public async deleteOlderThan(horizon: Date, limit: number): Promise<number> {
    const result: unknown = await this.deliveryRepository.query(
      'DELETE FROM notification_delivery WHERE created_at < ? LIMIT ?;',
      [horizon, limit],
    );
    const { affectedRows } = result as { affectedRows?: number };
    return affectedRows ?? 0;
  }
}
