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

    this.logger.info(
      { correlationId, variantId, stockLocationId },
      'Received event: catalog.variant.created — auto-initializing stock level',
    );

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
