import { Inject, Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';

import {
  IAllocationResult,
  IAllocationResultEntry,
  IReservationAllocatePayload,
  StockMovementTypeEnum,
} from '@retail-inventory-system/contracts';

import {
  InventoryDomainException,
  InventoryErrorCodeEnum,
  Reservation,
  ReservationStatusEnum,
  StockAllocatedEvent,
  StockLevel,
  StockMovement,
} from '../../domain';
import {
  IReservationRepositoryPort,
  IStockCachePort,
  IStockEventsPublisherPort,
  IStockMovementRepositoryPort,
  IStockRepositoryPort,
  ITransactionPort,
  ITransactionScope,
  RESERVATION_REPOSITORY,
  RESERVATION_TTL_MINUTES,
  STOCK_CACHE,
  STOCK_EVENTS_PUBLISHER,
  STOCK_MOVEMENT_REPOSITORY,
  STOCK_REPOSITORY,
  TRANSACTION_PORT,
} from '../ports';
import { emitMovementRecorded } from './movement-recorded.emitter';
import {
  INormalizedReservationLine,
  levelKey,
  loadDistinctLevels,
  normalizeReservationLines,
  reservationExpiresAt,
} from './reservation-mutation';
import { runWithStockWriteRetry } from './stock-mutation';

// One allocated line + the ledger row that records it, carried out of the
// transaction so the post-commit emits fire per line (result order preserved).
interface IAllocatedLine {
  entry: IAllocationResultEntry;
  movement: StockMovement;
}

// Allocate Stock converts a cart's active holds into an order's firm allocations at
// place-time (ADR-030 §4). Per line it commits the hold (`active → committed`,
// refreshing the TTL first when wall-clock-stale-but-still-held — the counters are
// still occupied so honoring it is oversell-safe until a sweeper lands) and moves
// the counter from reserved to allocated; when no active hold exists it falls back
// to a direct allocation against `available`. Either way it appends one negative
// `allocation` movement per line referencing the order.
//
// The whole order allocates **atomically or not at all**: all lines are computed
// (in-memory mutation + hold decisions, where `OUT_OF_STOCK` / state rejections
// throw) before ANY persist, then every distinct level is persisted once, every
// touched hold saved, every movement appended — all inside one
// `withInvalidation(runWithStockWriteRetry(...))`. A rejection on any line rolls
// the whole transaction back, so a partial allocation never commits — the contract
// the retail place transaction relies on (it invokes allocate pre-commit; a
// rejection rolls the place back).
@Injectable()
export class AllocateStockUseCase {
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
    @Inject(RESERVATION_TTL_MINUTES)
    private readonly ttlMinutes: number,
    @InjectPinoLogger(AllocateStockUseCase.name)
    private readonly logger: PinoLogger,
  ) {}

  public async execute(payload: IReservationAllocatePayload): Promise<IAllocationResult> {
    const { cartId, orderId, correlationId } = payload;

    this.logger.info(
      { correlationId, cartId, orderId, lineCount: payload.lines?.length },
      'Received RPC: allocate stock',
    );

    const lines = normalizeReservationLines(payload.lines, 'Allocate');

    const allocated = await this.stockCache.withInvalidation(
      () =>
        runWithStockWriteRetry(
          { transactionPort: this.transactionPort, logger: this.logger },
          (scope) => this.allocateOnce(scope, cartId, orderId, lines),
          { correlationId },
        ),
      // `withInvalidation` dedupes by variantId and wipes a per-variant prefix
      // covering every location facet, so the raw per-line items are enough.
      (rows) =>
        rows.map((row) => ({
          variantId: row.entry.variantId,
          stockLocationId: row.entry.stockLocationId,
        })),
      { correlationId },
    );

    this.logger.info(
      { correlationId, cartId, orderId, allocatedCount: allocated.length },
      'Stock allocated — order holds committed',
    );

    // Post-commit, best-effort (ADR-020), per allocated line.
    await Promise.all(allocated.map((row) => this.emitAllocated(row, orderId, correlationId)));

    return { allocated: allocated.map((row) => row.entry) };
  }

  // One transactional attempt: compute every line in memory first (so a rejection
  // leaves nothing persisted for ANY line), then write all. Re-reads each level +
  // hold fresh under the scope so a retried attempt never double-applies.
  private async allocateOnce(
    scope: ITransactionScope,
    cartId: string,
    orderId: number,
    lines: INormalizedReservationLine[],
  ): Promise<IAllocatedLine[]> {
    const now = new Date();
    const expiresAt = reservationExpiresAt(now, this.ttlMinutes);

    // Phase 1 — load each distinct (variantId, location) level exactly once,
    // capturing its optimistic token before any counter moves.
    const levels = await loadDistinctLevels(this.repository, lines, scope);

    // Phase 2 — compute per line (in-memory only). Any OUT_OF_STOCK / state
    // rejection throws here, before a single write below.
    const computed: { entry: IAllocationResultEntry; movement: StockMovement }[] = [];
    const reservationsToSave: Reservation[] = [];

    for (const line of lines) {
      const loaded = levels.get(levelKey(line.variantId, line.stockLocationId));
      // Unreachable: phase 1 inserted a level for every line's key.
      if (loaded === undefined) {
        throw new Error(
          `Allocate: level for ${line.variantId} @ ${line.stockLocationId} not loaded`,
        );
      }
      const { level } = loaded;

      const held = await this.reservationRepository.findByKey(
        cartId,
        line.variantId,
        line.stockLocationId,
        scope,
      );

      const reservationId = this.applyLineCounters(level, held, line, now, expiresAt);
      if (held !== null && reservationId !== null) {
        reservationsToSave.push(held);
      }

      computed.push({
        entry: {
          variantId: line.variantId,
          stockLocationId: line.stockLocationId,
          quantity: line.quantity,
          reservationId,
        },
        // Not yet appended — built here so the order is captured, persisted in
        // phase 3 to obtain the DB id the post-commit emit needs.
        movement: StockMovement.record({
          variantId: line.variantId,
          stockLocationId: line.stockLocationId,
          type: StockMovementTypeEnum.ALLOCATION,
          quantity: -line.quantity,
          reasonCode: null,
          referenceType: 'order',
          referenceId: String(orderId),
          actorId: null,
        }),
      });
    }

    // Phase 3 — write everything (all lines validated). Persist each distinct level
    // once with its captured token, save the committed holds, append the ledger
    // rows (re-read with their DB ids for the recorded-event emit).
    for (const { level, expectedVersion } of levels.values()) {
      await this.repository.persistStockLevelChange(level, expectedVersion, scope);
    }
    for (const reservation of reservationsToSave) {
      await this.reservationRepository.save(reservation, scope);
    }

    const allocated: IAllocatedLine[] = [];
    for (const row of computed) {
      const movement = await this.movementRepository.append(row.movement, scope);
      allocated.push({ entry: row.entry, movement });
    }

    return allocated;
  }

  // Decides the counter move for one line and returns the reservation id to surface
  // (null on the fallback path). Mutates `level` (and `held` when a hold is
  // committed) in memory only — no persistence here.
  private applyLineCounters(
    level: StockLevel,
    held: Reservation | null,
    line: INormalizedReservationLine,
    now: Date,
    expiresAt: Date,
  ): string | null {
    // Fallback path — no row, or a released/expired-status row (a removed/lapsed
    // hold): allocate straight from `available`. `OUT_OF_STOCK` (with
    // `details.available`) when short.
    if (held?.status !== ReservationStatusEnum.ACTIVE) {
      // A committed hold for the triple is a double-allocate attempt — the retail
      // idempotent re-place never calls allocate again, so this is defense-in-depth.
      if (held !== null && held.status === ReservationStatusEnum.COMMITTED) {
        throw new InventoryDomainException(
          InventoryErrorCodeEnum.RESERVATION_INVALID_STATE,
          `Allocate: hold ${held.id ?? '<unknown>'} for cart ${held.cartId} is already committed`,
        );
      }
      level.allocateDirect(line.quantity);
      return null;
    }

    // Common path — an active hold. When wall-clock-expired but still active, the
    // inline TTL policy refreshes it first (its counters are still held, so it is
    // oversell-safe) so `commit` does not reject an expired-but-honored hold.
    if (held.isExpired(now)) {
      held.refresh(held.quantity, expiresAt);
    }
    held.commit(now);

    if (held.quantity === line.quantity) {
      // Exact match: a pure reserved → allocated move (`available` unchanged).
      level.allocateFromReserved(line.quantity);
    } else {
      // Quantity drift between the hold and the order line: return the held units,
      // then allocate the order's quantity through `available` (which throws
      // `OUT_OF_STOCK` when the larger ask no longer fits).
      level.releaseReserved(held.quantity);
      level.allocateDirect(line.quantity);
    }

    return held.id;
  }

  private async emitAllocated(
    row: IAllocatedLine,
    orderId: number,
    correlationId: string,
  ): Promise<void> {
    const { entry, movement } = row;

    try {
      await this.publisher.publishStockAllocated(
        new StockAllocatedEvent({
          variantId: entry.variantId,
          stockLocationId: entry.stockLocationId,
          quantity: entry.quantity,
          orderId,
          reservationId: entry.reservationId,
        }),
        correlationId,
      );
    } catch (error) {
      this.logger.warn(
        { err: error as Error, correlationId, variantId: entry.variantId },
        'Failed to publish inventory.stock.allocated (allocation already committed)',
      );
    }

    await emitMovementRecorded(this.publisher, this.logger, movement, correlationId);
  }
}
