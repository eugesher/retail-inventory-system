import { randomUUID } from 'crypto';

import { Inject, Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';

import {
  ReservationReleaseReason,
  StockMovementTypeEnum,
} from '@retail-inventory-system/contracts';

import {
  Reservation,
  ReservationStatusEnum,
  StockMovement,
  StockReleasedEvent,
} from '../../domain';
import {
  IReservationRepositoryPort,
  IStockCachePort,
  IStockEventsPublisherPort,
  IStockMovementRepositoryPort,
  IStockRepositoryPort,
  ITransactionPort,
  ITransactionScope,
  OCC_RETRY_ATTEMPTS,
  RESERVATION_REPOSITORY,
  RESERVATION_SWEEP_BATCH_SIZE,
  RESERVATION_SWEEP_TRANSACTION_SIZE,
  STOCK_CACHE,
  STOCK_EVENTS_PUBLISHER,
  STOCK_MOVEMENT_REPOSITORY,
  STOCK_REPOSITORY,
  TRANSACTION_PORT,
} from '../ports';
import { emitMovementRecorded } from './movement-recorded.emitter';
import { runWithStockWriteRetry } from './stock-mutation';

// A TTL-driven reclaim reuses the existing `ReservationReleaseReason` member rather
// than minting a bespoke string: `StockReleasedEvent.reason` is typed by that union,
// and `stock_movement.reason_code` stores the same vocabulary from every release path
// (ADR-038). `type = 'release'` + `reason_code = 'expired'` is already unambiguous.
const EXPIRY_RELEASE_REASON: ReservationReleaseReason = 'expired';

export interface ISweepExpiredReservationsParams {
  // An operator override, clamped into `[1, RESERVATION_SWEEP_BATCH_SIZE]` — the
  // configured value is a ceiling, never a floor.
  batchSize?: number;
  correlationId?: string;
  // `null` for an unattended tick; a staff id when a human triggered the sweep. It is
  // written verbatim into `stock_movement.actor_id`.
  actorId?: string | null;
}

export interface ISweepExpiredReservationsResult {
  scanned: number;
  expired: number;
  skipped: number;
  durationMs: number;
}

// One expired hold + the ledger row that records it, carried out of the transaction so
// the post-commit emits can fire per row (the `ReleaseReservationUseCase` shape).
interface IExpiredRow {
  reservation: Reservation;
  movement: StockMovement;
}

// The outcome of one chunk's transaction: the rows it expired, and how many candidates
// it declined to touch because the row moved under it.
interface IExpiredChunk {
  rows: IExpiredRow[];
  skipped: number;
}

// Sweep Expired Reservations — the reclaim path for a stranded `active` hold (ADR-038).
// A hold whose cart was abandoned keeps its quantity counted into
// `stock_level.quantity_reserved` forever, permanently depressing `available`; nothing
// else in the system reclaims it. This use case scans for those holds, expires them in
// bounded batches, returns the held units to `available`, appends the negative `release`
// ledger row, and announces `inventory.stock.released` per row.
//
// Concurrency is settled WITHOUT a lock. The candidate scan is advisory: each row is
// re-read by id inside the transaction, and a row that is no longer `active` (a cart
// Remove Line, an Allocate, or a competing sweeper got there first) or whose `expiresAt`
// was pushed past this invocation's `now` is silently skipped. A lost compare-and-swap
// on the `StockLevel` raises `StockWriteConflictError`, `runWithStockWriteRetry` re-opens
// a fresh transaction, and every row in the chunk is re-read from the new snapshot — so
// `quantity_reserved` is decremented exactly once per hold, never twice.
//
// The use case does not guard its own throws: an exhausted retry budget surfaces
// `STOCK_WRITE_CONFLICT` and aborts the invocation. Whatever drives the sweep owns the
// decision to swallow that.
@Injectable()
export class SweepExpiredReservationsUseCase {
  constructor(
    @Inject(TRANSACTION_PORT)
    private readonly transactionPort: ITransactionPort,
    @Inject(STOCK_REPOSITORY)
    private readonly repository: IStockRepositoryPort,
    @Inject(RESERVATION_REPOSITORY)
    private readonly reservationRepository: IReservationRepositoryPort,
    @Inject(STOCK_MOVEMENT_REPOSITORY)
    private readonly movementRepository: IStockMovementRepositoryPort,
    @Inject(STOCK_CACHE)
    private readonly stockCache: IStockCachePort,
    @Inject(STOCK_EVENTS_PUBLISHER)
    private readonly publisher: IStockEventsPublisherPort,
    @Inject(OCC_RETRY_ATTEMPTS)
    private readonly maxAttempts: number,
    @Inject(RESERVATION_SWEEP_BATCH_SIZE)
    private readonly configuredBatchSize: number,
    @Inject(RESERVATION_SWEEP_TRANSACTION_SIZE)
    private readonly transactionSize: number,
    @InjectPinoLogger(SweepExpiredReservationsUseCase.name)
    private readonly logger: PinoLogger,
  ) {}

  public async execute(
    params: ISweepExpiredReservationsParams = {},
  ): Promise<ISweepExpiredReservationsResult> {
    const startedAt = Date.now();
    // Captured ONCE and threaded into every comparison, so a long sweep can never expire
    // a hold that was still live when the sweep began.
    const now = new Date();
    // A sweep has no request scope, so it mints its own trace id. Logged as an inline
    // field — `PinoLogger.assign()` is request-scoped and throws outside one (ADR-011).
    const correlationId = params.correlationId ?? randomUUID();
    const actorId = params.actorId ?? null;
    const limit = this.resolveLimit(params.batchSize);

    const candidates = await this.reservationRepository.listExpiredActive(now, limit);
    const scanned = candidates.length;

    if (scanned === 0) {
      this.logger.debug(
        { correlationId, now: now.toISOString() },
        'Reservation sweep: nothing expired',
      );
      return { scanned: 0, expired: 0, skipped: 0, durationMs: Date.now() - startedAt };
    }

    // A persisted hold always carries its `CHAR(36)` PK, so the filter is a type
    // narrowing rather than a real branch; seeding the skip counter with the (impossible)
    // drop keeps `scanned === expired + skipped` true by construction.
    const ids = candidates.map((row) => row.id).filter((id): id is string => id !== null);
    let expired = 0;
    let skipped = scanned - ids.length;
    let batches = 0;

    for (const chunk of chunkIds(ids, this.transactionSize)) {
      // ONE `withInvalidation` per chunk, not one around the whole sweep: ADR-023's
      // contract is that the cache is invalidated after the commit that changed the data.
      // A single call around every chunk would leave earlier chunks committed in MySQL
      // while the cache still served their pre-commit `available`.
      const outcome = await this.stockCache.withInvalidation(
        () =>
          runWithStockWriteRetry(
            {
              transactionPort: this.transactionPort,
              logger: this.logger,
              maxAttempts: this.maxAttempts,
            },
            (scope) => this.expireChunk(scope, chunk, now, actorId),
            { correlationId },
          ),
        (result) =>
          result.rows.map((row) => ({
            variantId: row.reservation.variantId,
            stockLocationId: row.reservation.stockLocationId,
          })),
        { correlationId },
      );

      expired += outcome.rows.length;
      skipped += outcome.skipped;
      batches += 1;

      // Post-commit, best-effort (ADR-020): the counters are already durable, so a broker
      // hiccup is warn-logged, never raised.
      await Promise.all(outcome.rows.map((row) => this.emitExpired(row, correlationId)));
    }

    const result: ISweepExpiredReservationsResult = {
      scanned,
      expired,
      skipped,
      durationMs: Date.now() - startedAt,
    };

    // A sweep that reclaimed something reflects real churn and is worth an `info` line; a
    // sweep that found only rows another writer already handled stays at `debug` so the
    // steady state does not flood the log (the `PurgeExpiredIdempotencyKeysUseCase`
    // precedent).
    const line = { correlationId, ...result, batches };
    if (expired > 0) {
      this.logger.info(line, 'Reservation sweep completed');
    } else {
      this.logger.debug(line, 'Reservation sweep completed — every candidate was skipped');
    }

    return result;
  }

  // The configured batch size is a CEILING an operator override cannot raise, and `1` is
  // the floor — a caller asking for zero rows gets one, never an empty scan that looks
  // like a clean table.
  private resolveLimit(requested?: number): number {
    if (requested === undefined) {
      return this.configuredBatchSize;
    }
    return Math.min(Math.max(Math.trunc(requested), 1), this.configuredBatchSize);
  }

  // One transactional attempt over one chunk. Every row is re-read under `scope`, so a
  // retried attempt sees the winning writer's post-state and skips rather than
  // double-decrementing. The WHOLE chunk retries as a unit.
  private async expireChunk(
    scope: ITransactionScope,
    ids: string[],
    now: Date,
    actorId: string | null,
  ): Promise<IExpiredChunk> {
    const rows: IExpiredRow[] = [];
    let skipped = 0;

    for (const id of ids) {
      const row = await this.reservationRepository.findById(id, scope);

      // Unlike Release — whose pre-transaction read is a client-facing 404 check — this
      // scan is advisory. Reservation rows are never deleted, but a vanished row must
      // never crash an unattended sweep.
      if (row === null) {
        skipped += 1;
        continue;
      }

      // Another sweeper, a cart Remove Line, or an Allocate got there first. This re-read
      // guard, not a lock, is what makes the sweep safe to run beside the write paths.
      if (row.status !== ReservationStatusEnum.ACTIVE) {
        skipped += 1;
        continue;
      }

      // A concurrent `refresh(...)` pushed `expiresAt` past the `now` this invocation
      // captured — the hold is live again.
      if (!row.isExpired(now)) {
        skipped += 1;
        continue;
      }

      const level = await this.repository.findStockLevel(row.variantId, row.stockLocationId, scope);
      if (level === null) {
        // An active hold whose level is gone is corruption — the reserve path that granted
        // the hold also created the level (the `ReleaseReservationUseCase` posture).
        throw new Error(
          `Sweep: stock level for variant ${row.variantId} @ ${row.stockLocationId} is missing`,
        );
      }

      // Capture the optimistic token BEFORE `releaseReserved` bumps it.
      const expectedVersion = level.version;
      level.releaseReserved(row.quantity);
      // `expire()` re-asserts `active` inside the transaction — belt and braces over the
      // status guard above.
      row.expire();
      await this.repository.persistStockLevelChange(level, expectedVersion, scope);
      const savedRow = await this.reservationRepository.save(row, scope);

      const movement = await this.movementRepository.append(
        StockMovement.record({
          variantId: row.variantId,
          stockLocationId: row.stockLocationId,
          type: StockMovementTypeEnum.RELEASE,
          quantity: -row.quantity,
          reasonCode: EXPIRY_RELEASE_REASON,
          referenceType: 'cart',
          referenceId: row.cartId,
          actorId,
        }),
        scope,
      );

      rows.push({ reservation: savedRow, movement });
    }

    return { rows, skipped };
  }

  // Emitted PER RESERVATION ROW, never coalesced per `(variantId, stockLocationId)`:
  // coalescing would have to sum quantities and null `cartId` / `reservationId`, which is
  // the whole correlation value the event carries (ADR-038).
  private async emitExpired(row: IExpiredRow, correlationId: string): Promise<void> {
    const { reservation, movement } = row;

    try {
      await this.publisher.publishStockReleased(
        new StockReleasedEvent({
          variantId: reservation.variantId,
          stockLocationId: reservation.stockLocationId,
          quantity: reservation.quantity,
          cartId: reservation.cartId,
          reservationId: reservation.id,
          reason: EXPIRY_RELEASE_REASON,
        }),
        correlationId,
      );
    } catch (error) {
      this.logger.warn(
        { err: error as Error, correlationId, variantId: reservation.variantId },
        'Failed to publish inventory.stock.released (expiry already committed)',
      );
    }

    await emitMovementRecorded(this.publisher, this.logger, movement, correlationId);
  }
}

// Splits the candidate ids into transaction-sized groups, preserving the oldest-first
// order the scan established.
function chunkIds(ids: string[], size: number): string[][] {
  const chunks: string[][] = [];
  for (let start = 0; start < ids.length; start += size) {
    chunks.push(ids.slice(start, start + size));
  }
  return chunks;
}
