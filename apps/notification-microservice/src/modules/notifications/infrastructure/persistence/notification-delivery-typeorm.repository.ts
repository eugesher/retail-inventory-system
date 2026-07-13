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

  // The retention sweep's HARD delete (ISSUE-08) — the only statement in this repository that removes
  // a row, and the only reason `notification_delivery` is no longer unbounded.
  //
  // **`DELETE`, not `softDelete`.** `BaseTypeormRepository` offers the latter and it is the wrong verb
  // here: the row IS the dedupe anchor (`delivery_dedupe_key`), so a soft-deleted row the dedupe query
  // no longer sees means the same notification is sent twice. `deletedAt` on this table is inert by
  // design, and this sweep does not change that — it removes the row entirely or leaves it alone.
  //
  // **Bounded, and re-driven rather than looped.** `LIMIT` keeps one sweep from taking a table-sized
  // lock on the hot path of every order; the scheduler runs again on its next tick and takes the next
  // batch. A first purge after a long backlog therefore drains over several ticks, on purpose.
  //
  // `created_at` is the horizon column, not `last_attempt_at`: retention is about how old the RECORD
  // is, not when it was last touched, and a delivery that failed and was retried for a week is still
  // ninety days old at ninety days.
  // **Parameterized raw SQL, and not by preference.** TypeORM's `DeleteQueryBuilder` has no `.limit()`
  // and `repository.delete()` takes no bound at all — so an ORM-shaped version of this would be an
  // *unbounded* `DELETE` on the busiest table in the schema. The bound is the point; the ORM is not.
  public async deleteOlderThan(horizon: Date, limit: number): Promise<number> {
    // `Repository.query` is typed `Promise<any>`, so the driver's answer is asserted once — here —
    // and never leaves this method as `any`. `mysql2` answers a DELETE with an `OkPacket` carrying
    // `affectedRows`.
    const result: unknown = await this.deliveryRepository.query(
      'DELETE FROM notification_delivery WHERE created_at < ? LIMIT ?;',
      [horizon, limit],
    );
    const { affectedRows } = result as { affectedRows?: number };
    return affectedRows ?? 0;
  }
}
