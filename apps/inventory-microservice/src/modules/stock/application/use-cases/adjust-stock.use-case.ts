import { Inject, Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';

import {
  INVENTORY_DEFAULT_STOCK_LOCATION,
  IStockAdjustPayload,
  StockLevelView,
  StockMovementTypeEnum,
} from '@retail-inventory-system/contracts';

import {
  InventoryDomainException,
  InventoryErrorCodeEnum,
  StockAdjustedEvent,
  StockLevel,
  StockMovement,
} from '../../domain';
import {
  IStockCachePort,
  IStockEventsPublisherPort,
  IStockMovementRepositoryPort,
  IStockRepositoryPort,
  ITransactionPort,
  STOCK_CACHE,
  STOCK_EVENTS_PUBLISHER,
  STOCK_MOVEMENT_REPOSITORY,
  STOCK_REPOSITORY,
  TRANSACTION_PORT,
} from '../ports';
import { maybeEmitLowStock } from './low-stock.emitter';
import { emitMovementRecorded } from './movement-recorded.emitter';
import { applyOnHandChange } from './stock-mutation';
import { requireActiveLocation } from './stock-location.guard';
import { toStockLevelView } from './stock-view.factory';

// Adjust Stock is the second Stage-1 write operation on the new model (ADR-027):
// it applies a signed delta to a variant's on-hand quantity at one stock location
// with a mandatory `reasonCode`. The domain `changeOnHand` rejects a result below
// zero (surfaced as a 409 at the gateway). The transactional read-modify-write is
// wrapped in `stockCache.withInvalidation(...)` so the cached availability is
// invalidated **after** the commit (ADR-023). The reserved-surface
// `inventory.stock.adjusted` event is emitted afterwards, and the preserved
// `inventory.stock.low` event re-fires when the post-commit on-hand falls at or
// below `INVENTORY_DEFAULT_LOW_STOCK_THRESHOLD` (best-effort, ADR-020).
//
// Adjust appends a signed `adjustment` `StockMovement` row **inside the same
// transaction** as the counter write (ADR-030 §2) — its `quantity` is the signed
// delta and its `reasonCode` is the mandatory operator reason, attributed to the
// acting staff user (`actorId`, null = system). The running total stays the balance
// authority (ADR-027); the ledger row is the immutable audit record. A below-zero
// rejection throws before the persist, so neither the counter nor a ledger row is
// written. The reserved-surface `inventory.stock-movement.recorded` event is the
// third post-commit emit alongside adjusted + maybe-low.
@Injectable()
export class AdjustStockUseCase {
  constructor(
    @Inject(TRANSACTION_PORT)
    private readonly transactionPort: ITransactionPort,
    @Inject(STOCK_REPOSITORY)
    private readonly repository: IStockRepositoryPort,
    @Inject(STOCK_MOVEMENT_REPOSITORY)
    private readonly movementRepository: IStockMovementRepositoryPort,
    @Inject(STOCK_CACHE)
    private readonly stockCache: IStockCachePort,
    @Inject(STOCK_EVENTS_PUBLISHER)
    private readonly publisher: IStockEventsPublisherPort,
    @InjectPinoLogger(AdjustStockUseCase.name)
    private readonly logger: PinoLogger,
  ) {}

  public async execute(payload: IStockAdjustPayload): Promise<StockLevelView> {
    const { variantId, quantityDelta, reasonCode, actorId, correlationId } = payload;
    const stockLocationId = payload.stockLocationId ?? INVENTORY_DEFAULT_STOCK_LOCATION;

    this.logger.info(
      { correlationId, variantId, stockLocationId, quantityDelta, reasonCode, actorId },
      'Received RPC: adjust stock',
    );

    // Backstops for the directly-reachable RMQ path — the gateway DTO rejects a
    // zero/non-integer delta and an empty reason first (a 400 at the edge).
    if (!Number.isInteger(quantityDelta) || quantityDelta === 0) {
      throw new InventoryDomainException(
        InventoryErrorCodeEnum.STOCK_ADJUSTMENT_DELTA_INVALID,
        `Adjustment delta must be a non-zero integer, got ${quantityDelta}`,
      );
    }
    if (typeof reasonCode !== 'string' || reasonCode.trim().length === 0) {
      throw new InventoryDomainException(
        InventoryErrorCodeEnum.STOCK_ADJUSTMENT_REASON_REQUIRED,
        'Adjustment reasonCode is mandatory and must be a non-empty string',
      );
    }

    await requireActiveLocation(this.repository, stockLocationId);

    // The shared mutator owns the write protocol (ADR-027): post-commit cache
    // invalidation (ADR-023) around a bounded optimistic retry around the
    // transactional find-or-init → changeOnHand → version-checked persist →
    // ledger append. `changeOnHand` throws `STOCK_RESULT_NEGATIVE` before any save
    // when the delta would drive on-hand below zero; that domain rejection is not
    // retried and propagates out so no cache mutation, no ledger row, and no event
    // fires, mapped to a 409. `buildMovement` records the signed `adjustment` row
    // in the same transaction as the counter, so they commit atomically.
    const { level: saved, movement } = await applyOnHandChange(
      {
        transactionPort: this.transactionPort,
        repository: this.repository,
        movementRepository: this.movementRepository,
        stockCache: this.stockCache,
        logger: this.logger,
      },
      {
        variantId,
        stockLocationId,
        delta: quantityDelta,
        correlationId,
        buildMovement: (persisted) =>
          StockMovement.record({
            variantId: persisted.variantId,
            stockLocationId: persisted.stockLocationId,
            type: StockMovementTypeEnum.ADJUSTMENT,
            quantity: quantityDelta, // signed, non-zero — `adjustment` accepts both signs
            reasonCode,
            referenceType: null,
            referenceId: null,
            actorId: actorId ?? null,
          }),
      },
    );

    this.logger.info(
      { correlationId, variantId, stockLocationId, quantityDelta, newOnHand: saved.quantityOnHand },
      'Stock adjusted — signed delta applied',
    );

    // Post-commit, best-effort (ADR-020). The three emits are independent and
    // each swallows its own failure, so they run concurrently — removing serial
    // broker round-trips from the RPC.
    await Promise.all([
      this.emitAdjusted(saved, quantityDelta, reasonCode, actorId, correlationId),
      maybeEmitLowStock(this.publisher, this.logger, saved, quantityDelta, correlationId),
      emitMovementRecorded(this.publisher, this.logger, movement, correlationId),
    ]);

    return toStockLevelView(saved);
  }

  private async emitAdjusted(
    saved: StockLevel,
    quantityDelta: number,
    reasonCode: string,
    actorId?: string,
    correlationId?: string,
  ): Promise<void> {
    try {
      await this.publisher.publishStockAdjusted(
        new StockAdjustedEvent({
          variantId: saved.variantId,
          stockLocationId: saved.stockLocationId,
          quantityDelta,
          reasonCode,
          newOnHand: saved.quantityOnHand,
          actorId,
        }),
        correlationId,
      );
    } catch (error) {
      this.logger.warn(
        { err: error as Error, correlationId, variantId: saved.variantId },
        'Failed to publish inventory.stock.adjusted (write already committed)',
      );
    }
  }

  // The low-stock depletion alert (Adjust's negative-delta path) is the shared
  // `maybeEmitLowStock` helper — the same policy Transfer's source leg reuses; the
  // `adjustment` ledger announce is the shared `emitMovementRecorded` helper.
}
