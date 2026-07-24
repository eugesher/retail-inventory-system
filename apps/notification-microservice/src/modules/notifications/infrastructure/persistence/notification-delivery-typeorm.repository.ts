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

// The single `@InjectRepository(NotificationDeliveryEntity)` site for the
// `NotificationDelivery` aggregate. A single-row upsert (no owned children), re-reading
// by id so the returned aggregate carries the generated BIGINT id + committed
// timestamps. Returns domain types only — no TypeORM leak (ADR-017).
//
// **It implements the port DIRECTLY, without `BaseTypeormRepository`** — the convention the
// append-only repositories already follow (`stock_movement`, `domain_event`,
// `audit_log_entry`, `idempotency_key`). It used to extend the base, and the extension bought
// nothing: this class overrides `save`, and every other method reaches for
// `this.deliveryRepository.*` rather than the inherited `find`/`save`/`softDelete`. All the
// base contributed was an obligation to implement `toDomain`/`toEntity`, two `protected`
// methods **nothing ever called** — the ADR-049 shape, where an unreachable member is a claim
// the code does not honour. The mapper is called at each site instead, which is where it was
// being called from anyway.
//
// `softDelete` going away with it is a feature, not a loss: `deletedAt` on this table is inert
// **by design** (the row is the dedupe anchor), so inheriting a soft-delete verb this
// repository must never use was the wrong shape twice over.
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

  // The retry sweeper's scan, in two arms (see the port for the full argument):
  //
  //  1. `failed` rows under their attempt budget (`attempt_count < maxAttempts`) — the
  //     ordinary recorded failure the sweeper drains.
  //  2. `queued` rows older than `queuedStaleBefore` — a delivery ORPHANED between the
  //     persist and the dispatch. Nothing else in the service scans `queued`, so without
  //     this arm such a row is unreachable forever, which is what ADR-033 §3 says must not
  //     happen. The `created_at` bound is what keeps the sweeper off a row that is being
  //     dispatched right now.
  //
  // An ARRAY of `where` objects is TypeORM's OR: the two arms are ORed, and the conditions
  // inside each object are ANDed. Ordered oldest-attempt-first; a queued row's
  // `last_attempt_at` is NULL and MySQL sorts NULLs first ascending, so orphans lead the
  // batch — correct, since a `failed` row was at least attempted and an orphan may never
  // have been sent. A plain `find` (not `findAndCount`) — the sweeper only iterates the
  // batch, so it never pays for a `COUNT(*)` it would discard.
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
