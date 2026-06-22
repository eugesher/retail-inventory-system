import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DeepPartial, FindOptionsWhere, LessThan, Repository } from 'typeorm';

import {
  NotificationChannelEnum,
  NotificationDeliveryStatusEnum,
} from '@retail-inventory-system/contracts';
import { BaseTypeormRepository } from '@retail-inventory-system/database';

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

// The single `@InjectRepository(NotificationDeliveryEntity)` site for the
// `NotificationDelivery` aggregate. A single-row upsert (no owned children), re-reading
// by id so the returned aggregate carries the generated BIGINT id + committed
// timestamps. Returns domain types only — no TypeORM leak (ADR-017).
@Injectable()
export class NotificationDeliveryTypeormRepository
  extends BaseTypeormRepository<NotificationDeliveryEntity, NotificationDelivery>
  implements INotificationDeliveryRepositoryPort
{
  constructor(
    @InjectRepository(NotificationDeliveryEntity)
    private readonly deliveryRepository: Repository<NotificationDeliveryEntity>,
  ) {
    super(deliveryRepository);
  }

  protected toDomain(entity: NotificationDeliveryEntity): NotificationDelivery {
    return NotificationDeliveryMapper.toDomain(entity);
  }

  protected toEntity(domain: NotificationDelivery): DeepPartial<NotificationDeliveryEntity> {
    return NotificationDeliveryMapper.toEntity(domain);
  }

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
      // The double-dispatch race: another consumer already INSERTed a customer-facing
      // delivery for this `(templateId, eventReferenceType, eventReferenceId, channel,
      // recipientCustomerId)` tuple, so this INSERT collides on the dedupe UNIQUE index.
      // Re-load and return the winner's row — the dispatch is idempotent (ADR-033). Only
      // customer-facing rows are deduped (a null `recipientCustomerId` ⇒ null dedupe key
      // ⇒ never a collision), so this branch is gated on a non-null recipient.
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

  // The explicit idempotency pre-check — queries by the five dedupe component columns
  // (the same tuple the generated `delivery_dedupe_key` concatenates, `templateId`
  // included so distinct event types sharing one business reference are not collapsed).
  // Only meaningful for customer-facing notifications (a null `recipientCustomerId` is
  // not a dedupe scope).
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

  // The paged, filtered audit read — newest-first (`created_at DESC, id DESC` so the
  // order is total when two rows share a timestamp).
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

  // The retry sweeper's scan: `failed` rows that have not yet exhausted their attempt
  // budget (`attempt_count < maxAttempts`), oldest-attempt-first so the longest-waiting
  // delivery retries next. Served by the `(status, last_attempt_at)` index. A plain
  // `find` (not `findAndCount`) — the sweeper only iterates the batch, so it never pays
  // for a `COUNT(*)` it would discard.
  public async listRetryable(maxAttempts: number, limit: number): Promise<NotificationDelivery[]> {
    const entities = await this.deliveryRepository.find({
      where: {
        status: NotificationDeliveryStatusEnum.FAILED,
        attemptCount: LessThan(maxAttempts),
      },
      order: { lastAttemptAt: 'ASC', id: 'ASC' },
      take: limit,
    });

    return entities.map((entity) => NotificationDeliveryMapper.toDomain(entity));
  }
}
