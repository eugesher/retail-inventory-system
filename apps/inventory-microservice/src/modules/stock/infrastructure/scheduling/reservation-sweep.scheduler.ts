import { Inject, Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';

import { RESERVATION_SWEEP_INTERVAL_SECONDS } from '../../application/ports';
import { SweepExpiredReservationsUseCase } from '../../application/use-cases';

// The registry key for the timer this class installs. Exported because
// `onModuleDestroy` must delete the interval under the same name it added, and because a
// test that needs to reach the live timer resolves `SchedulerRegistry` and asks for it.
export const RESERVATION_SWEEP_INTERVAL_NAME = 'reservation-ttl-sweep';

// The timer that drives the expired-reservation sweep (ADR-038). **A schedule lives in
// `infrastructure/`, never in a use case** — this class holds no sweep logic at all; it decides
// only *when* and guards the tick so a thrown sweep cannot kill the loop.
//
// **The cadence is CONFIGURED, which is why the interval is registered imperatively** rather than
// declared with a schedule decorator. A decorator's `ms` argument is evaluated when the class is
// *defined* — long before DI can resolve an injected value — so a configured cadence simply cannot
// be expressed that way. `SchedulerRegistry` is the seam Nest provides for exactly this.
//
// The interval decides only how promptly an already-expired hold is reclaimed;
// `RESERVATION_TTL_MINUTES` is what bounds a hold's life. A cadence longer than the TTL
// stays oversell-safe — `available` merely understates reality for up to one interval past
// the TTL (ADR-038 Consequences).
@Injectable()
export class ReservationSweepScheduler implements OnModuleInit, OnModuleDestroy {
  // `setInterval` fires on a fixed cadence regardless of how long the previous callback ran.
  // `RESERVATION_SWEEP_INTERVAL_SECONDS` has a Joi floor of 1, and a full-ceiling batch under
  // write contention takes far longer than that, so an overlapping tick is reachable by
  // configuration alone. Two concurrent sweeps are CORRECT — they scan the same candidates
  // and the loser's compare-and-swap turns into a skip (ADR-038) — but the loser reclaims
  // nothing while burning its whole `OCC_RETRY_ATTEMPTS` budget against the winner. Skipping
  // the tick outright is strictly better than racing ourselves. It does not (and need not)
  // exclude the `inventory.reservation.sweep` RPC: that path is safe by the same re-read.
  private sweeping = false;

  constructor(
    private readonly sweeper: SweepExpiredReservationsUseCase,
    private readonly schedulerRegistry: SchedulerRegistry,
    @Inject(RESERVATION_SWEEP_INTERVAL_SECONDS)
    private readonly intervalSeconds: number,
    @InjectPinoLogger(ReservationSweepScheduler.name)
    private readonly logger: PinoLogger,
  ) {}

  public onModuleInit(): void {
    const intervalMs = this.intervalSeconds * 1000;
    const handle = setInterval(() => void this.sweep(), intervalMs);
    this.schedulerRegistry.addInterval(RESERVATION_SWEEP_INTERVAL_NAME, handle);
    // Inline `intervalSeconds` — a scheduler has no request scope, so the request-scoped
    // `assign()` helper on the logger would throw here (ADR-011 §7). One line per boot, at
    // `info`: it is the only proof from outside the process that the sweep is armed, and at
    // what cadence.
    this.logger.info({ intervalSeconds: this.intervalSeconds }, 'Reservation sweep scheduled');
  }

  // An imperative `setInterval` outlives the Nest container that created it. Left running,
  // the timer keeps firing against torn-down repositories and keeps the Node event loop
  // alive, which in a Jest run means the worker never exits. `deleteInterval` clears the
  // handle and drops it from the registry.
  //
  // `SchedulerOrchestrator.beforeApplicationShutdown` currently clears the WHOLE registry,
  // so this would mostly happen anyway — but that is a library internal, not a contract,
  // and it needs `app.close()` to fire. Deleting what we added keeps the handle's lifetime
  // ours. The `doesExist` guard is load-bearing: `deleteInterval` resolves through
  // `getInterval`, which throws on an unknown name, so an unguarded call on a container
  // that never reached `onModuleInit` would mask the real failure.
  public onModuleDestroy(): void {
    if (this.schedulerRegistry.doesExist('interval', RESERVATION_SWEEP_INTERVAL_NAME)) {
      this.schedulerRegistry.deleteInterval(RESERVATION_SWEEP_INTERVAL_NAME);
    }
  }

  // The use case mints its own `correlationId` per invocation and reads its own bounds, so
  // the tick passes nothing.
  private async sweep(): Promise<void> {
    if (this.sweeping) {
      this.logger.debug({}, 'Reservation sweep still running — skipping this tick');
      return;
    }

    this.sweeping = true;
    try {
      await this.sweeper.execute();
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      // A sweep fault must not stop the scheduler — log and let the next tick try again.
      // The use case deliberately does not guard its own throws: an exhausted
      // `OCC_RETRY_ATTEMPTS` budget surfaces `STOCK_WRITE_CONFLICT` here, and under
      // contention that is a transient condition the next tick resolves.
      this.logger.warn({ reason }, 'Reservation sweep failed');
    } finally {
      // `finally`, never after the `catch`: a throw must not wedge the flag on and silence
      // the timer for the life of the process.
      this.sweeping = false;
    }
  }
}
