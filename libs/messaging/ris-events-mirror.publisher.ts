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
// The generous best-effort-emit bound (ms). A broker that is unreachable does NOT
// reject `emit()` — amqp-connection-manager buffers the publish and the returned
// Observable stays *pending*, which a `try/catch` cannot catch. So every best-effort
// emit is bounded by an rxjs `timeout`: past this window it rejects (and is swallowed)
// instead of hanging the mutation that already committed. It matters most for the real
// audit-log adapters, whose ONLY publish is a mirror — a down broker would otherwise
// hang a staff login/refresh/logout or a committed refund. The bound is generous (a
// healthy broker acks in milliseconds, so it only ever bites during an outage).
export const BEST_EFFORT_EMIT_TIMEOUT_MS = 5_000;

// The single home for the "materialize a cold `emit()`, bound it with a timeout, await
// the ack, and swallow any rejection (warn-log, never throw)" sequence every best-effort
// post-commit publish needs (ADR-020/035). Both the `ris.events` mirror leg (below) and
// a producer's primary emit onto a consumer queue (e.g. the api-gateway customer-events
// publisher onto `notification_events`) reuse it, so the bound + swallow lives in exactly
// one place. Generic over any correlation-bearing payload so the FULL event — not just
// `correlationId` — rides the wire while the warn line still carries the trace id.
export async function emitBestEffort<T extends ICorrelationPayload>(
  client: ClientProxy,
  routingKey: string,
  payload: T,
  logger: PinoLogger,
  failMessage: string,
  timeoutMs: number = BEST_EFFORT_EMIT_TIMEOUT_MS,
): Promise<void> {
  try {
    await firstValueFrom(
      client.emit<void, T>(routingKey, payload).pipe(timeout({ each: timeoutMs })),
    );
  } catch (error) {
    // Best-effort: a rejected OR timed-out emit is swallowed (warn-logged, never
    // rethrown) so it can never block the mutation that already committed. The full
    // `payload` rides the warn line so a dropped event stays recoverable from the logs.
    logger.warn(
      { routingKey, correlationId: payload.correlationId, payload, err: error as Error },
      failMessage,
    );
  }
}

@Injectable()
export class RisEventsMirrorPublisher {
  constructor(
    @Inject(MicroserviceClientTokenEnum.RIS_EVENTS_PUBLISHER)
    private readonly client: ClientProxy,
    @InjectPinoLogger(RisEventsMirrorPublisher.name)
    private readonly logger: PinoLogger,
  ) {}

  public async mirror(routingKey: string, payload: ICorrelationPayload): Promise<void> {
    await emitBestEffort(
      this.client,
      routingKey,
      payload,
      this.logger,
      'Failed to mirror event onto ris.events',
    );
  }
}
