import { Controller } from '@nestjs/common';
import { Ctx, EventPattern, Payload, RmqContext } from '@nestjs/microservices';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';

import { IAuditStaffActionEvent } from '@retail-inventory-system/contracts';
import { ROUTING_KEYS } from '@retail-inventory-system/messaging';

import { IngestAuditLogUseCase } from './audit-log';
import { IngestDomainEventUseCase } from './domain-events';

// The single firehose consumer for the event store's `audit-and-events` context. The
// service binds ONE queue (`event_store_firehose_queue`) to the `ris.events` topic
// exchange, so this one `@EventPattern('#')` handler receives EVERY event the platform
// publishes and dispatches it by the concrete routing key (ADR-035). A second queue was
// rejected: one Nest app binds every `@EventPattern` to every connected transport, so
// disjoint pattern sets across two queues are not cleanly supported — the in-consumer
// routing-key switch is the decided shape.
//
// The catch-all pattern is `#`, NOT `#.#`. With `wildcards: true` the `@EventPattern`
// string is used both as the AMQP binding routing key AND as Nest's own dispatch matcher
// (`matchRmqPattern`). That matcher only treats `#` as "match every remaining word" when
// it is the LAST pattern segment, so `#.#` matches no multi-word routing key and Nest
// nacks it as an "unsupported event". A lone `#` is the segment-0-and-last catch-all that
// matches any key — and binds as `#` in AMQP, which also routes every key.
//
// It deliberately lives at the CONTEXT ROOT, beside the `AuditAndEventsModule`
// aggregator, not inside either sibling module's `infrastructure/`. It fans out into
// BOTH modules' ingest use cases (`domain-events` and `audit-log`), so it belongs to
// neither — and the `eslint-plugin-boundaries` taxonomy reflects that exactly: a module's
// `infrastructure/` may inject only its OWN module's use cases (the `sameModule` rule), so
// a cross-module dispatcher cannot live there. The context root matches no element-type
// pattern (like the aggregator module itself), which is the honest home for a concern
// that spans the whole bounded context.
//
// A thin adapter (ADR-011 §4): it reads the routing key, picks the ingest use case, and
// logs — all real logic is in the use cases. It NEVER rethrows: an exception from an
// `@EventPattern` makes the broker blind-redeliver in a hot loop (ADR-011 §7). The use
// cases already swallow their own errors; the try/catch here is the belt-and-braces
// backstop for anything thrown before they run (e.g. reading the routing key).
@Controller()
export class FirehoseConsumer {
  constructor(
    private readonly ingestDomainEvent: IngestDomainEventUseCase,
    private readonly ingestAuditLog: IngestAuditLogUseCase,
    @InjectPinoLogger(FirehoseConsumer.name)
    private readonly logger: PinoLogger,
  ) {}

  @EventPattern('#')
  public async onFirehoseEvent(
    @Payload() payload: Record<string, unknown>,
    @Ctx() context: RmqContext,
  ): Promise<void> {
    // The wildcard `@EventPattern('#.#')` is what binds the queue to `ris.events`, but
    // `context.getPattern()` would return that wildcard. The CONCRETE routing key the
    // producer emitted under lives on the raw AMQP message metadata — cast the loosely
    // typed amqplib message to the one field we read.
    const message = context.getMessage() as { fields: { routingKey: string } };
    const routingKey = message.fields.routingKey;
    const correlationId = typeof payload?.correlationId === 'string' ? payload.correlationId : '';

    this.logger.info({ correlationId, routingKey }, 'Consuming ris.events firehose message');

    try {
      if (routingKey === ROUTING_KEYS.AUDIT_STAFF_ACTION) {
        // The cross-cutting staff-action stream goes ONLY to the audit log — an audit
        // action never also lands in `domain_event` (the two logs stay distinct, ADR-035).
        await this.ingestAuditLog.execute(payload as unknown as IAuditStaffActionEvent);
      } else {
        // Everything else is a raw business event for the firehose log.
        await this.ingestDomainEvent.execute(routingKey, payload);
      }
    } catch (error) {
      this.logger.warn(
        { err: error as Error, correlationId, routingKey },
        'Firehose ingest failed — dropping message (never rethrow from @EventPattern)',
      );
    }
  }
}
