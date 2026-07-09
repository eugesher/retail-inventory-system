import { Inject, Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';

import { clampPageWindow } from '@retail-inventory-system/common';
import {
  DomainEventView,
  IDomainEventQueryPayload,
  IPage,
} from '@retail-inventory-system/contracts';

import { DOMAIN_EVENT_REPOSITORY, IDomainEventRepositoryPort } from '../ports';
import { toDomainEventView } from './domain-event-view.factory';

// Query Domain Events: the paginated, filterable read of the append-only `domain_event`
// firehose log (ADR-039). Until this shipped, the event store ingested every event the
// system published and could answer nothing about them.
//
// Every filter narrows the scan and every filter names an INDEXED column — `eventType`,
// `aggregateType` + `aggregateId`, `correlationId`, and an inclusive `occurredAt` window.
// An absent filter widens it, so an empty filter reads the whole log, newest-first. The
// opaque `payload` JSON is returned but never searched: an unindexable predicate over an
// ever-growing append-only table degrades into a full scan.
//
// **Uncached by design.** The audit query is low-frequency, operator-driven, and expects the
// latest rows; caching would add an invalidation hop on every ingest — i.e. on the system's
// highest-volume write stream — for no hit-rate benefit (the `stock_movement` ledger
// precedent). So this use case takes no cache port.
//
// An unknown filter value is a valid answer: an empty page (`items: []`, `total: 0`), never a
// 404. So is an inverted `from`/`to` range, which the repository's `BETWEEN hi AND lo`
// evaluates to the empty set. The event store therefore needs no `*DomainException` /
// `*RpcExceptionFilter` pair — a shape error is the gateway DTO's business.
@Injectable()
export class QueryDomainEventsUseCase {
  constructor(
    @Inject(DOMAIN_EVENT_REPOSITORY)
    private readonly repository: IDomainEventRepositoryPort,
    @InjectPinoLogger(QueryDomainEventsUseCase.name)
    private readonly logger: PinoLogger,
  ) {}

  public async execute(payload: IDomainEventQueryPayload): Promise<IPage<DomainEventView>> {
    const { filters, correlationId } = payload;

    // Clamp the untrusted (page, pageSize) — an RMQ handler is directly reachable, so a
    // malformed page (0, negative, fractional) or an oversized pageSize must be normalized
    // before it reaches the repository's `skip((page - 1) * size)`. This single call IS the
    // "max pageSize 100" rule; it is not duplicated in the gateway DTO, so every caller —
    // including a future one that bypasses the gateway — inherits the same cap.
    const { page, size } = clampPageWindow(payload.page, payload.pageSize, {
      defaultPage: 1,
      defaultSize: 20,
      maxSize: 100,
    });

    this.logger.info(
      { correlationId, filters, page, size },
      'Received RPC: query domain events (firehose audit read)',
    );

    // The filters cross the seam verbatim — the repository owns both the predicate mapping
    // (an absent field contributes no predicate) and the `occurred_at DESC, id DESC` order.
    const eventsPage = await this.repository.query(filters, { page, size });

    // `page` / `size` are the applied window, echoed back from the repository; `total` is the
    // full-match count, so a client can compute the page count.
    return {
      items: eventsPage.items.map(toDomainEventView),
      total: eventsPage.total,
      page: eventsPage.page,
      size: eventsPage.size,
    };
  }
}
