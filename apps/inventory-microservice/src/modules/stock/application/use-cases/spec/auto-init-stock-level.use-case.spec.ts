import { PinoLogger } from 'nestjs-pino';

import {
  ICatalogVariantCreatedEvent,
  INVENTORY_DEFAULT_STOCK_LOCATION,
} from '@retail-inventory-system/contracts';

import { StockLevel, StockLevelInitializedEvent } from '../../../domain';
import { IStockEventsPublisherPort } from '../../ports';
import { AutoInitStockLevelUseCase } from '../auto-init-stock-level.use-case';
import { InMemoryStockRepository } from './test-doubles';

// Records `publishStockLevelInitialized` calls so the spec can assert the event
// fires exactly once (and never on the idempotent paths). The other two port
// methods are no-ops — auto-init only emits the initialized event.
class RecordingStockEventsPublisher implements IStockEventsPublisherPort {
  public readonly initialized: { event: StockLevelInitializedEvent; correlationId?: string }[] = [];

  public publishStockLow(): Promise<void> {
    return Promise.resolve();
  }

  public publishStockReserved(): Promise<void> {
    return Promise.resolve();
  }

  public publishStockLevelInitialized(
    event: StockLevelInitializedEvent,
    correlationId?: string,
  ): Promise<void> {
    this.initialized.push({ event, correlationId });
    return Promise.resolve();
  }
}

const VARIANT_ID = 42;
const CORRELATION_ID = 'corr-auto-init-1';

const variantCreatedEvent = (
  overrides: Partial<ICatalogVariantCreatedEvent> = {},
): ICatalogVariantCreatedEvent => ({
  productId: 7,
  variantId: VARIANT_ID,
  sku: 'SKU-AERON-BLK-M',
  eventVersion: 'v1',
  occurredAt: '2026-06-08T12:00:00.000Z',
  correlationId: CORRELATION_ID,
  ...overrides,
});

// A silent logger so the spec asserts behaviour, not log output.
const silentLogger = (): PinoLogger =>
  ({
    info: jest.fn(),
    debug: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  }) as unknown as PinoLogger;

describe('AutoInitStockLevelUseCase', () => {
  let repository: InMemoryStockRepository;
  let publisher: RecordingStockEventsPublisher;
  let useCase: AutoInitStockLevelUseCase;

  beforeEach(() => {
    repository = new InMemoryStockRepository();
    publisher = new RecordingStockEventsPublisher();
    useCase = new AutoInitStockLevelUseCase(repository, publisher, silentLogger());
  });

  it('creates a zeroed default-warehouse stock level and emits the event once for a new variant', async () => {
    await useCase.execute(variantCreatedEvent());

    const saved = await repository.findStockLevel(VARIANT_ID, INVENTORY_DEFAULT_STOCK_LOCATION);
    expect(saved).not.toBeNull();
    expect(saved?.stockLocationId).toBe(INVENTORY_DEFAULT_STOCK_LOCATION);
    expect(saved?.quantityOnHand).toBe(0);
    expect(saved?.quantityAllocated).toBe(0);
    expect(saved?.quantityReserved).toBe(0);
    expect(saved?.available).toBe(0);
    expect(saved?.version).toBe(0);

    expect(publisher.initialized).toHaveLength(1);
    const [emitted] = publisher.initialized;
    expect(emitted.event).toBeInstanceOf(StockLevelInitializedEvent);
    expect(emitted.event.aggregateId).toBe(VARIANT_ID);
    expect(emitted.event.stockLocationId).toBe(INVENTORY_DEFAULT_STOCK_LOCATION);
    expect(emitted.correlationId).toBe(CORRELATION_ID);
  });

  it('is a no-op for a repeat event when the row already exists (no save, no event)', async () => {
    repository.seedLevel(StockLevel.initialAt(VARIANT_ID, INVENTORY_DEFAULT_STOCK_LOCATION));
    const saveSpy = jest.spyOn(repository, 'saveStockLevel');

    await useCase.execute(variantCreatedEvent());

    expect(saveSpy).not.toHaveBeenCalled();
    expect(publisher.initialized).toHaveLength(0);
  });

  it('swallows a unique-violation from saveStockLevel as the already-exists no-op', async () => {
    // The find returns null (so the use case proceeds to save), but the INSERT
    // loses a race and the UNIQUE backstop fires — a duplicate-key driver error.
    const duplicateError = Object.assign(new Error('Duplicate entry'), {
      driverError: { code: 'ER_DUP_ENTRY', errno: 1062 },
    });
    jest.spyOn(repository, 'saveStockLevel').mockRejectedValueOnce(duplicateError);

    await expect(useCase.execute(variantCreatedEvent())).resolves.toBeUndefined();

    expect(publisher.initialized).toHaveLength(0);
  });

  it('rethrows a non-duplicate persistence error', async () => {
    const otherError = new Error('connection reset');
    jest.spyOn(repository, 'saveStockLevel').mockRejectedValueOnce(otherError);

    await expect(useCase.execute(variantCreatedEvent())).rejects.toBe(otherError);
    expect(publisher.initialized).toHaveLength(0);
  });
});
