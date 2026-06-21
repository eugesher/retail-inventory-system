import { Inject, Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';

import { randomUUID } from 'node:crypto';

import {
  INotificationDeliveryRepositoryPort,
  MAX_DELIVERY_ATTEMPTS,
  NOTIFICATION_DELIVERY_REPOSITORY,
} from '../ports';
import { RetryDeliveryUseCase } from './retry-delivery.use-case';

// Exponential backoff base (milliseconds). The gate the sweeper applies is
// `lastAttemptAt + baseMs * 2^(attemptCount - 1) > now` ⇒ skip. So after the 1st failure
// (`attemptCount === 1`) a row waits `baseMs`, after the 2nd `2 * baseMs`, etc. A small
// base keeps the retry loop (and the e2e that exercises it) fast while still spacing
// attempts; production tuning would raise it (a `ConfigService` knob is future work).
const RETRY_BACKOFF_BASE_MS = 1_000;

// One sweep processes at most this many retryable rows. `listRetryable` orders
// oldest-attempt-first, so a backlog larger than a page drains across successive sweeps
// (the longest-waiting deliveries always retry first). Bounding the batch keeps a single
// sweep's NOTIFIER fan-out predictable.
const SWEEP_BATCH_SIZE = 50;

// A small summary of one sweep — returned for observability + unit assertions (the
// scheduler ignores it). `scanned` is the retryable rows the scan returned, `skipped`
// those still inside their backoff window, `retried` those re-dispatched this sweep.
export interface IRetrySweepResult {
  scanned: number;
  skipped: number;
  retried: number;
}

// Retry Failed Deliveries — the scheduled sweeper (ADR-033) driven by
// `@nestjs/schedule`'s `DeliveryRetryScheduler`. It scans `failed` deliveries that have
// not yet exhausted their `MAX_DELIVERY_ATTEMPTS` budget (`listRetryable`), applies the
// exponential backoff gate, and re-dispatches each due row through
// `RetryDeliveryUseCase.reattempt` — the same single re-dispatch + cap-emit path the
// manual retry uses. A row that reaches the cap stays `failed`, emits
// `notifications.delivery.failed` once (inside `reattempt`), and is excluded from every
// subsequent scan.
//
// Unlike the manual retry, the sweeper **honors the backoff gate**: a row whose
// `lastAttemptAt + backoff(attemptCount)` is still in the future is skipped this sweep and
// retried on a later one (once enough time has elapsed). A per-sweep `correlationId`
// threads the sweep's own logs; each delivery is retried under its own persisted
// `correlationId` so the retry stays joined to the original dispatch's trace.
@Injectable()
export class RetryFailedDeliveriesUseCase {
  constructor(
    @Inject(NOTIFICATION_DELIVERY_REPOSITORY)
    private readonly deliveryRepo: INotificationDeliveryRepositoryPort,
    private readonly retryDelivery: RetryDeliveryUseCase,
    @Inject(MAX_DELIVERY_ATTEMPTS)
    private readonly maxAttempts: number,
    @InjectPinoLogger(RetryFailedDeliveriesUseCase.name)
    private readonly logger: PinoLogger,
  ) {}

  public async execute(): Promise<IRetrySweepResult> {
    const sweepCorrelationId = randomUUID();
    const now = new Date();

    const { items } = await this.deliveryRepo.listRetryable(this.maxAttempts, {
      page: 1,
      size: SWEEP_BATCH_SIZE,
    });

    let skipped = 0;
    let retried = 0;

    for (const delivery of items) {
      if (!this.isDue(delivery.lastAttemptAt, delivery.attemptCount, now)) {
        skipped += 1;
        continue;
      }
      // Re-dispatch under the delivery's own correlationId (trace continuity). A
      // per-row failure must not abort the sweep — `reattempt` records a failed retry on
      // the row rather than throwing, but a repository/transport fault could still
      // surface here, so each row is isolated.
      try {
        await this.retryDelivery.reattempt(delivery, delivery.correlationId);
        retried += 1;
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        this.logger.warn(
          { correlationId: sweepCorrelationId, deliveryId: delivery.id, reason },
          'Retry sweep: a delivery retry threw; continuing',
        );
      }
    }

    this.logger.info(
      { correlationId: sweepCorrelationId, scanned: items.length, skipped, retried },
      'Notification delivery retry sweep complete',
    );

    return { scanned: items.length, skipped, retried };
  }

  // The backoff gate: a row is due when its last attempt is at least `backoff(attemptCount)`
  // in the past. A row with no recorded attempt (defensive — a `failed` row always has one)
  // is treated as immediately due.
  private isDue(lastAttemptAt: Date | null, attemptCount: number, now: Date): boolean {
    if (lastAttemptAt === null) {
      return true;
    }
    const backoffMs = RETRY_BACKOFF_BASE_MS * 2 ** Math.max(0, attemptCount - 1);
    return lastAttemptAt.getTime() + backoffMs <= now.getTime();
  }
}
