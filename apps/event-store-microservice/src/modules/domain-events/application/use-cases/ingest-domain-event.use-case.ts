import { Inject, Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';

import { DomainEvent } from '../../domain';
import { DOMAIN_EVENT_REPOSITORY, IDomainEventRepositoryPort } from '../ports';
import { resolveAggregateId, resolveAggregateType, resolveProducer } from './firehose-extractors';

// The ingest path for the event firehose: turns one wire event that crossed the
// `ris.events` topic exchange into one append-only `domain_event` row
// (docs/adr/035-event-store-firehose-topic-exchange.md). It handles EVERY routing key
// except `audit.staff.action` (which the firehose consumer routes to the audit-log
// ingest instead — the two logs stay distinct, ADR-035).
//
// Two postures define this use case, both forced by RabbitMQ being at-least-once
// (ADR-020):
//
//   * Idempotent. The `domain_event` table carries a composite UNIQUE
//     `(producer, event_type, aggregate_id, occurred_at, correlation_id)`; the repository
//     swallows the dup as `{ inserted: false }`, so a redelivery is absorbed with no
//     second row and no error. For that key to actually collide, an absent/empty wire
//     `correlationId` is coalesced to `''` HERE (the column is nullable and MySQL treats
//     NULLs as distinct in a UNIQUE index, so a NULL correlation id would slip past the
//     dedupe on every redelivery).
//
//   * Crash-safe / never-rethrow. A consumer that throws inside an `@EventPattern` makes
//     the broker blind-redeliver in a hot loop (ADR-011 §7). So malformed input is
//     dropped with a warn (the message is acked), and any thrown build/persist error is
//     caught and swallowed — at-least-once plus the idempotency key make a future
//     redelivery safe to retry.
@Injectable()
export class IngestDomainEventUseCase {
  constructor(
    @Inject(DOMAIN_EVENT_REPOSITORY)
    private readonly repository: IDomainEventRepositoryPort,
    @InjectPinoLogger(IngestDomainEventUseCase.name)
    private readonly logger: PinoLogger,
  ) {}

  public async execute(routingKey: string, payload: Record<string, unknown>): Promise<void> {
    // Coalesce an absent/empty wire correlation id to `''` (NOT null) so the composite
    // UNIQUE dedups redeliveries. `@EventPattern` handlers are not request-scoped, so the
    // id rides inline on each log line — `PinoLogger.assign()` would throw (ADR-011 §7).
    const correlationId =
      typeof payload.correlationId === 'string' && payload.correlationId.length > 0
        ? payload.correlationId
        : '';

    // The one hard rejection: `occurred_at` is the producer emit time and part of the
    // idempotency key, so a missing or unparseable value cannot be defaulted without
    // corrupting dedupe. Warn + drop (the message is still acked — re-emitting a fixed
    // event is the producer's job, not ours to retry).
    const occurredAt = this.parseOccurredAt(payload.occurredAt);
    if (occurredAt === null) {
      this.logger.warn(
        { correlationId, routingKey, occurredAt: payload.occurredAt },
        'Dropping firehose event — missing or invalid occurredAt',
      );
      return;
    }

    try {
      const event = DomainEvent.create({
        eventType: routingKey,
        aggregateType: resolveAggregateType(routingKey),
        aggregateId: resolveAggregateId(payload),
        payload,
        eventVersion: typeof payload.eventVersion === 'string' ? payload.eventVersion : 'v1',
        producer: resolveProducer(routingKey),
        correlationId,
        occurredAt,
      });

      const { inserted } = await this.repository.append(event);

      if (inserted) {
        this.logger.debug(
          { correlationId, routingKey, producer: event.producer, aggregateId: event.aggregateId },
          'Firehose event appended to domain_event',
        );
      } else {
        // The composite-UNIQUE collided: this is a redelivery of an already-stored event.
        // The idempotency guarantee made real — no second row, no error.
        this.logger.debug(
          { correlationId, routingKey, aggregateId: event.aggregateId },
          'Duplicate domain_event dropped — idempotent no-op',
        );
      }
    } catch (error) {
      // A thrown build/JSON/DB error is caught and swallowed (never rethrown): the
      // message is acked, and at-least-once + the idempotency key keep a later
      // redelivery safe.
      this.logger.warn(
        { err: error as Error, correlationId, routingKey },
        'Failed to ingest firehose event — dropping message',
      );
    }
  }

  // Parse the wire ISO-8601 `occurredAt` into a `Date`, returning null for an absent,
  // non-string, or unparseable value (the "missing-field rejection" the caller acts on).
  private parseOccurredAt(raw: unknown): Date | null {
    if (typeof raw !== 'string' || raw.length === 0) {
      return null;
    }
    const date = new Date(raw);
    return Number.isNaN(date.getTime()) ? null : date;
  }
}
