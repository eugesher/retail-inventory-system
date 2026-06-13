import { Inject, Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';

import {
  INVENTORY_DEFAULT_STOCK_LOCATION,
  IStockReceivePayload,
  StockLevelView,
  StockMovementTypeEnum,
} from '@retail-inventory-system/contracts';

import {
  InventoryDomainException,
  InventoryErrorCodeEnum,
  StockLevel,
  StockMovement,
  StockReceivedEvent,
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
import { applyOnHandChange } from './stock-mutation';
import { requireActiveLocation } from './stock-location.guard';
import { toStockLevelView } from './stock-view.factory';

// Receive Stock is the first Stage-1 write operation on the new model (ADR-027):
// it raises a variant's on-hand quantity at one stock location by a positive
// amount. The transactional read-modify-write is wrapped in
// `stockCache.withInvalidation(...)` so the cached availability is invalidated
// **after** the commit (ADR-023) — the write body is `work`, `resolveItems`
// yields the `(variantId, stockLocationId)` to wipe, and the prefix delete runs
// post-commit. Receive never lowers on-hand, so there is no low-stock check.
//
// Receive also appends a positive `receipt` `StockMovement` row **inside the same
// transaction** as the counter write (ADR-030 §2): the running total stays the
// balance authority (ADR-027), and the ledger row is the immutable audit record of
// why on-hand rose, attributed to the acting staff user (`actorId`, null = system).
// Two reserved-surface events fire post-commit, best-effort and independent
// (ADR-020): `inventory.stock.received` and `inventory.stock-movement.recorded`.
@Injectable()
export class ReceiveStockUseCase {
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
    @InjectPinoLogger(ReceiveStockUseCase.name)
    private readonly logger: PinoLogger,
  ) {}

  public async execute(payload: IStockReceivePayload): Promise<StockLevelView> {
    const { variantId, quantity, actorId, correlationId } = payload;
    const stockLocationId = payload.stockLocationId ?? INVENTORY_DEFAULT_STOCK_LOCATION;

    this.logger.info(
      { correlationId, variantId, stockLocationId, quantity, actorId },
      'Received RPC: receive stock',
    );

    // Backstop for the directly-reachable RMQ path — the gateway DTO rejects a
    // non-positive quantity first (a 400 at the edge before the RPC dispatches).
    if (!Number.isInteger(quantity) || quantity <= 0) {
      throw new InventoryDomainException(
        InventoryErrorCodeEnum.STOCK_RECEIVE_QUANTITY_INVALID,
        `Receive quantity must be a positive integer, got ${quantity}`,
      );
    }

    await requireActiveLocation(this.repository, stockLocationId);

    // The shared mutator owns the write protocol (ADR-027): post-commit cache
    // invalidation (ADR-023) around a bounded optimistic retry around the
    // transactional find-or-init → changeOnHand → version-checked persist →
    // ledger append. `buildMovement` records the positive `receipt` row in the
    // same transaction, so the counter rise and its audit trail commit atomically.
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
        delta: quantity,
        correlationId,
        buildMovement: (persisted) =>
          StockMovement.record({
            variantId: persisted.variantId,
            stockLocationId: persisted.stockLocationId,
            type: StockMovementTypeEnum.RECEIPT,
            quantity, // positive — the received amount (a `receipt` is +ve by sign rule)
            reasonCode: null,
            referenceType: null,
            referenceId: null,
            actorId: actorId ?? null,
          }),
      },
    );

    this.logger.info(
      { correlationId, variantId, stockLocationId, newOnHand: saved.quantityOnHand },
      'Stock received — on-hand raised',
    );

    // Post-commit, best-effort (ADR-020): a publish failure is warn-logged, not
    // raised — the write already committed, so failing the RPC would mislead the
    // caller into thinking the receive did not happen. The two emits are
    // independent and each swallows its own failure, so they run concurrently.
    await Promise.all([
      this.emitReceived(saved, quantity, actorId, correlationId),
      this.emitMovementRecorded(saved, movement, correlationId),
    ]);

    return toStockLevelView(saved);
  }

  private async emitReceived(
    saved: StockLevel,
    quantityDelta: number,
    actorId?: string,
    correlationId?: string,
  ): Promise<void> {
    try {
      await this.publisher.publishStockReceived(
        new StockReceivedEvent({
          variantId: saved.variantId,
          stockLocationId: saved.stockLocationId,
          quantityDelta,
          newOnHand: saved.quantityOnHand,
          actorId,
        }),
        correlationId,
      );
    } catch (error) {
      this.logger.warn(
        { err: error as Error, correlationId, variantId: saved.variantId },
        'Failed to publish inventory.stock.received (write already committed)',
      );
    }
  }

  // The ledger row committed with the counter; this only announces it (ADR-030 §2).
  // Best-effort like every post-commit emit — a broker hiccup must not fail the RPC.
  // `movement` is always present on the receive path (a `buildMovement` factory is
  // always supplied), but the helper's result type is nullable, so guard for safety.
  private async emitMovementRecorded(
    saved: StockLevel,
    movement: StockMovement | null,
    correlationId?: string,
  ): Promise<void> {
    if (movement === null) {
      return;
    }
    try {
      await this.publisher.publishStockMovementRecorded(movement, correlationId);
    } catch (error) {
      this.logger.warn(
        { err: error as Error, correlationId, variantId: saved.variantId },
        'Failed to publish inventory.stock-movement.recorded (write already committed)',
      );
    }
  }
}
