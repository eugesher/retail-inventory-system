import { Inject, Injectable } from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { firstValueFrom } from 'rxjs';

import {
  ICorrelationPayload,
  MicroserviceClientTokenEnum,
} from '@retail-inventory-system/contracts';

// The shared mirror publisher for the `ris.events` topic exchange (ADR-035) —
// the **single** place the dual-publish `emit` boilerplate lives.
//
// A producer that already emits an event onto its existing default-exchange
// destination calls `mirror(routingKey, payload)` to publish the *same* routing
// key + payload onto `ris.events` as well, so the event store captures the whole
// firehose without any existing consumer being re-bound. The held `ClientProxy`
// is the `RIS_EVENTS_PUBLISHER` topic-exchange client (see
// `MicroserviceClientRisEventsModule`); with `wildcards: true` + the named
// exchange, the first `emit` argument is used as the AMQP topic routing key.
//
// Per ADR-020, publishing is best-effort and post-commit: this method awaits the
// broker ack but does not retry, and **swallows its own rejection** (warn-log, no
// throw) so the dozens of domain-event call sites need no `try/catch`. A dropped
// mirror never blocks the mutation that already committed, and — because callers
// order the mirror *after* their primary `emit` — a mirror hiccup can never shadow
// the primary publish that feeds the real consumers. The at-least-once broker plus
// the event store's idempotent ingest absorb the duplicate delivery a retry would
// otherwise need. (The audit-log adapters use the same `RIS_EVENTS_PUBLISHER`
// client directly rather than this helper, because they map a domain event into a
// wire shape first; this helper is the seam the domain-event publishers reuse for
// the bulk fan-out.)
@Injectable()
export class RisEventsMirrorPublisher {
  constructor(
    @Inject(MicroserviceClientTokenEnum.RIS_EVENTS_PUBLISHER)
    private readonly client: ClientProxy,
    @InjectPinoLogger(RisEventsMirrorPublisher.name)
    private readonly logger: PinoLogger,
  ) {}

  public async mirror(routingKey: string, payload: ICorrelationPayload): Promise<void> {
    try {
      await firstValueFrom(this.client.emit<void, ICorrelationPayload>(routingKey, payload));
    } catch (error) {
      this.logger.warn(
        { routingKey, correlationId: payload.correlationId, err: error as Error },
        'Failed to mirror event onto ris.events',
      );
    }
  }
}
