import { Inject, Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';

import {
  INVENTORY_DEFAULT_LOW_STOCK_THRESHOLD,
  INVENTORY_DEFAULT_STOCK_LOCATION,
  IStockAdjustPayload,
  StockLevelView,
} from '@retail-inventory-system/contracts';

import {
  InventoryDomainException,
  InventoryErrorCodeEnum,
  StockAdjustedEvent,
  StockLevel,
  StockLowEvent,
} from '../../domain';
import {
  IStockCachePort,
  IStockEventsPublisherPort,
  IStockRepositoryPort,
  ITransactionPort,
  STOCK_CACHE,
  STOCK_EVENTS_PUBLISHER,
  STOCK_REPOSITORY,
  TRANSACTION_PORT,
} from '../ports';
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
// `reasonCode` is carried in the request, the `inventory.stock.adjusted` payload,
// and the logs only — **no `StockMovement` row is written** (that audit ledger
// lands with a later inventory-reservation / audit capability).
@Injectable()
export class AdjustStockUseCase {
  constructor(
    @Inject(TRANSACTION_PORT)
    private readonly transactionPort: ITransactionPort,
    @Inject(STOCK_REPOSITORY)
    private readonly repository: IStockRepositoryPort,
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
    // transactional find-or-init → changeOnHand → version-checked persist.
    // `changeOnHand` throws `STOCK_RESULT_NEGATIVE` before any save when the delta
    // would drive on-hand below zero; that domain rejection is not retried and
    // propagates out so no cache mutation or event fires, mapped to a 409.
    const saved = await applyOnHandChange(
      {
        transactionPort: this.transactionPort,
        repository: this.repository,
        stockCache: this.stockCache,
        logger: this.logger,
      },
      { variantId, stockLocationId, delta: quantityDelta, correlationId },
    );

    this.logger.info(
      { correlationId, variantId, stockLocationId, quantityDelta, newOnHand: saved.quantityOnHand },
      'Stock adjusted — signed delta applied',
    );

    // Post-commit, best-effort (ADR-020). The two emits are independent and
    // each swallows its own failure, so they run concurrently — on the
    // low-stock path this removes one serial broker round-trip from the RPC.
    await Promise.all([
      this.emitAdjusted(saved, quantityDelta, reasonCode, actorId, correlationId),
      this.maybeEmitLow(saved, quantityDelta, correlationId),
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

  // Re-sourced from the new model: the preserved low-stock alert fires on the
  // post-commit `StockLevel.quantityOnHand`, against the cross-service constant
  // threshold (ADR-012 §low-stock). It is a depletion signal — emitted only when
  // a NEGATIVE delta drives on-hand to at/below the threshold (the spec wording
  // "falls at/below", and the unit coverage, both trigger on a decrease). A
  // positive adjustment that merely leaves on-hand low has not "fallen" and must
  // not raise a reorder alert — a write that increases stock is never a low-stock
  // event.
  private async maybeEmitLow(
    saved: StockLevel,
    quantityDelta: number,
    correlationId?: string,
  ): Promise<void> {
    if (quantityDelta >= 0 || saved.quantityOnHand > INVENTORY_DEFAULT_LOW_STOCK_THRESHOLD) {
      return;
    }

    this.logger.info(
      {
        correlationId,
        variantId: saved.variantId,
        stockLocationId: saved.stockLocationId,
        quantity: saved.quantityOnHand,
        threshold: INVENTORY_DEFAULT_LOW_STOCK_THRESHOLD,
      },
      'On-hand at/below threshold — emitting inventory.stock.low',
    );

    try {
      await this.publisher.publishStockLow(
        new StockLowEvent({
          variantId: saved.variantId,
          stockLocationId: saved.stockLocationId,
          quantity: saved.quantityOnHand,
          threshold: INVENTORY_DEFAULT_LOW_STOCK_THRESHOLD,
        }),
        correlationId,
      );
    } catch (error) {
      this.logger.warn(
        { err: error as Error, correlationId, variantId: saved.variantId },
        'Failed to publish inventory.stock.low (write already committed)',
      );
    }
  }
}
