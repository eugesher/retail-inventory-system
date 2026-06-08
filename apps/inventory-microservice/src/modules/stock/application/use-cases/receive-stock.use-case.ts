import { Inject, Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';

import {
  INVENTORY_DEFAULT_STOCK_LOCATION,
  IStockReceivePayload,
  StockLevelView,
} from '@retail-inventory-system/contracts';

import {
  InventoryDomainException,
  InventoryErrorCodeEnum,
  StockLevel,
  StockReceivedEvent,
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
import { requireActiveLocation } from './stock-location.guard';
import { toStockLevelView } from './stock-view.factory';

// Receive Stock is the first Stage-1 write operation on the new model (ADR-027):
// it raises a variant's on-hand quantity at one stock location by a positive
// amount. The transactional read-modify-write is wrapped in
// `stockCache.withInvalidation(...)` so the cached availability is invalidated
// **after** the commit (ADR-023) — the write body is `work`, `resolveItems`
// yields the `(variantId, stockLocationId)` to wipe, and the prefix delete runs
// post-commit. The reserved-surface `inventory.stock.received` event is emitted
// afterwards (best-effort, ADR-020). Receive never lowers on-hand, so there is no
// low-stock check.
@Injectable()
export class ReceiveStockUseCase {
  constructor(
    @Inject(TRANSACTION_PORT)
    private readonly transactionPort: ITransactionPort,
    @Inject(STOCK_REPOSITORY)
    private readonly repository: IStockRepositoryPort,
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

    // Transactional read-modify-write wrapped so the cache wipe runs post-commit
    // (ADR-023). `work` resolves only after the save has committed, so
    // `resolveItems` → the prefix delete is genuinely after the write is durable.
    const saved = await this.stockCache.withInvalidation(
      () =>
        this.transactionPort.runInTransaction(async () => {
          const level =
            (await this.repository.findStockLevel(variantId, stockLocationId)) ??
            StockLevel.initialAt(variantId, stockLocationId);
          level.changeOnHand(quantity);
          return this.repository.saveStockLevel(level);
        }),
      (result) => [{ variantId: result.variantId, stockLocationId: result.stockLocationId }],
      { correlationId },
    );

    this.logger.info(
      { correlationId, variantId, stockLocationId, newOnHand: saved.quantityOnHand },
      'Stock received — on-hand raised',
    );

    // Post-commit, best-effort (ADR-020): a publish failure is warn-logged, not
    // raised — the write already committed, so failing the RPC would mislead the
    // caller into thinking the receive did not happen.
    await this.emitReceived(saved, quantity, actorId, correlationId);

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
}
