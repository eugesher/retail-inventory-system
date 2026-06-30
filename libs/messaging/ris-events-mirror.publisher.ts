import { Inject, Injectable } from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { firstValueFrom, timeout } from 'rxjs';

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
// otherwise need. (Both the domain-event publishers and the real audit-log adapters
// reuse this one helper — the audit adapters map their event to the wire shape first,
// then mirror it, so the emit + swallow lives in exactly one place.)
//
// A broker that is unreachable does NOT reject the `emit` — amqp-connection-manager
// buffers the publish and the returned Observable stays *pending*, which a `try/catch`
// cannot catch. So the emit is bounded by an rxjs `timeout`: past this window it rejects
// (and is swallowed) instead of hanging, making the documented "never blocks the
// committed mutation" contract real. It matters most for the real audit-log adapters,
// whose ONLY publish is this mirror — a down broker would otherwise hang a staff
// login/refresh/logout or a committed refund, paths the zero-I/O no-op publisher these
// adapters replaced never blocked. The bound is generous (a healthy broker acks in
// milliseconds, so it only ever bites during an outage).
const RIS_EVENTS_MIRROR_TIMEOUT_MS = 5_000;

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
      await firstValueFrom(
        this.client
          .emit<void, ICorrelationPayload>(routingKey, payload)
          .pipe(timeout({ each: RIS_EVENTS_MIRROR_TIMEOUT_MS })),
      );
    } catch (error) {
      // Best-effort: a rejected OR timed-out emit is swallowed (warn-logged, never
      // rethrown) so it can never block the mutation that already committed. The full
      // `payload` rides the warn line so a dropped event — above all an always-audit
      // money movement — stays recoverable from the logs (the no-op publisher these
      // adapters replaced logged the whole audit record locally).
      this.logger.warn(
        { routingKey, correlationId: payload.correlationId, payload, err: error as Error },
        'Failed to mirror event onto ris.events',
      );
    }
  }
}
