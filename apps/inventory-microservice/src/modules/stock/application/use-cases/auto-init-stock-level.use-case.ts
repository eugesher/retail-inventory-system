import { Inject, Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';

import {
  ICatalogVariantCreatedEvent,
  INVENTORY_DEFAULT_STOCK_LOCATION,
} from '@retail-inventory-system/contracts';

import { StockLevel, StockLevelInitializedEvent } from '../../domain';
import {
  IStockEventsPublisherPort,
  IStockRepositoryPort,
  STOCK_EVENTS_PUBLISHER,
  STOCK_REPOSITORY,
} from '../ports';
import { isDuplicateEntryError } from './mysql-error.util';

// Auto-init turns a catalog `variant.created` event into a zeroed `stock_level`
// row for the new variant at the default warehouse, so the inventory read path
// has a figure to serve as soon as a variant exists (ADR-027). It is the first
// cross-service event consumer beyond notification.
//
// Idempotent by design — a repeat event for an already-initialized variant is a
// no-op (no duplicate row, no second `inventory.stock-level.initialized`):
//   1. Fast path: `findStockLevel` short-circuits when the row already exists.
//   2. Backstop: if two events race past the find, the UNIQUE constraint rejects
//      the loser's INSERT; the duplicate-key driver error is swallowed as the
//      already-exists no-op.
// The event fires only when a genuinely new row is created.
@Injectable()
export class AutoInitStockLevelUseCase {
  constructor(
    @Inject(STOCK_REPOSITORY)
    private readonly repository: IStockRepositoryPort,
    @Inject(STOCK_EVENTS_PUBLISHER)
    private readonly publisher: IStockEventsPublisherPort,
    @InjectPinoLogger(AutoInitStockLevelUseCase.name)
    private readonly logger: PinoLogger,
  ) {}

  public async execute(event: ICatalogVariantCreatedEvent): Promise<void> {
    const { variantId, correlationId } = event;
    const stockLocationId = INVENTORY_DEFAULT_STOCK_LOCATION;

    // `@EventPattern` handlers are not request-scoped, so `correlationId` rides
    // inline on each log line — `PinoLogger.assign()` would throw here (ADR-011).
    this.logger.info(
      { correlationId, variantId, stockLocationId },
      'Received event: catalog.variant.created — auto-initializing stock level',
    );

    // Fast-path idempotency: an existing row means a prior event already
    // initialized this variant. No save, no event.
    const existing = await this.repository.findStockLevel(variantId, stockLocationId);
    if (existing !== null) {
      this.logger.debug(
        { correlationId, variantId, stockLocationId },
        'Stock level already initialized — no-op',
      );
      return;
    }

    try {
      await this.repository.saveStockLevel(StockLevel.initialAt(variantId, stockLocationId));
    } catch (error) {
      // Backstop idempotency: a concurrent event won the INSERT; the UNIQUE
      // constraint rejected ours. Treat as the already-exists no-op — no event.
      if (isDuplicateEntryError(error)) {
        this.logger.debug(
          { correlationId, variantId, stockLocationId },
          'Stock level created concurrently (unique violation) — no-op',
        );
        return;
      }
      this.logger.error(
        { err: error as Error, correlationId, variantId, stockLocationId },
        'Error auto-initializing stock level',
      );
      throw error;
    }

    this.logger.info(
      { correlationId, variantId, stockLocationId },
      'Stock level initialized — emitting inventory.stock-level.initialized',
    );

    await this.publisher.publishStockLevelInitialized(
      new StockLevelInitializedEvent({ variantId, stockLocationId }),
      correlationId,
    );
  }
}
