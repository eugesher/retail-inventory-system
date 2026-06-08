import { PinoLogger } from 'nestjs-pino';

import { INVENTORY_DEFAULT_STOCK_LOCATION } from '@retail-inventory-system/contracts';
import { makePinoLoggerMock } from '@retail-inventory-system/observability/testing';

import {
  InventoryDomainException,
  InventoryErrorCodeEnum,
  StockLevel,
  StockLocation,
  StockLocationTypeEnum,
} from '../../../domain';
import { ReceiveStockUseCase } from '../receive-stock.use-case';
import {
  ImmediateTransactionPort,
  InMemoryStockCache,
  InMemoryStockRepository,
  RecordingStockEventsPublisher,
} from './test-doubles';

const VARIANT_ID = 42;
const CORRELATION_ID = 'corr-receive-1';

const activeLocation = (id = INVENTORY_DEFAULT_STOCK_LOCATION): StockLocation =>
  new StockLocation({
    id,
    name: `Loc ${id}`,
    code: id.toUpperCase(),
    type: StockLocationTypeEnum.WAREHOUSE,
  });

describe('ReceiveStockUseCase', () => {
  let repository: InMemoryStockRepository;
  let cache: InMemoryStockCache;
  let publisher: RecordingStockEventsPublisher;
  let transaction: ImmediateTransactionPort;
  let useCase: ReceiveStockUseCase;

  beforeEach(() => {
    repository = new InMemoryStockRepository();
    cache = new InMemoryStockCache();
    publisher = new RecordingStockEventsPublisher();
    transaction = new ImmediateTransactionPort();
    repository.seedLocation(activeLocation());
    useCase = new ReceiveStockUseCase(
      transaction,
      repository,
      cache,
      publisher,
      makePinoLoggerMock() as unknown as PinoLogger,
    );
  });

  it('raises on-hand by the received quantity and returns the updated view', async () => {
    repository.seedLevel(
      new StockLevel({
        variantId: VARIANT_ID,
        stockLocationId: INVENTORY_DEFAULT_STOCK_LOCATION,
        quantityOnHand: 10,
        quantityAllocated: 0,
        quantityReserved: 0,
        version: 0,
      }),
    );

    const view = await useCase.execute({
      variantId: VARIANT_ID,
      quantity: 50,
      correlationId: CORRELATION_ID,
    });

    expect(view.stockLocationId).toBe(INVENTORY_DEFAULT_STOCK_LOCATION);
    expect(view.quantityOnHand).toBe(60);
    expect(view.available).toBe(60);

    const persisted = await repository.findStockLevel(VARIANT_ID, INVENTORY_DEFAULT_STOCK_LOCATION);
    expect(persisted?.quantityOnHand).toBe(60);
  });

  it('defaults the stock location to the default warehouse when none is given', async () => {
    await useCase.execute({ variantId: VARIANT_ID, quantity: 5 });

    const persisted = await repository.findStockLevel(VARIANT_ID, INVENTORY_DEFAULT_STOCK_LOCATION);
    expect(persisted?.quantityOnHand).toBe(5);
  });

  it('lazy-initializes a missing stock level then applies the receive', async () => {
    // No seeded level for this variant — the use case find-or-initialAt's a zeroed
    // level and applies the delta on top of it.
    const view = await useCase.execute({ variantId: 999, quantity: 7 });

    expect(view.quantityOnHand).toBe(7);
    const persisted = await repository.findStockLevel(999, INVENTORY_DEFAULT_STOCK_LOCATION);
    expect(persisted).not.toBeNull();
    expect(persisted?.quantityOnHand).toBe(7);
  });

  it.each([0, -3, 1.5])('rejects a non-positive / non-integer quantity (%p)', async (quantity) => {
    await expect(useCase.execute({ variantId: VARIANT_ID, quantity })).rejects.toMatchObject({
      code: InventoryErrorCodeEnum.STOCK_RECEIVE_QUANTITY_INVALID,
    });

    expect(publisher.received).toHaveLength(0);
    expect(cache.invalidations).toHaveLength(0);
  });

  it('rejects when the target location is deactivated', async () => {
    const location = activeLocation('back-store');
    location.deactivate();
    repository.seedLocation(location);

    await expect(
      useCase.execute({ variantId: VARIANT_ID, stockLocationId: 'back-store', quantity: 1 }),
    ).rejects.toBeInstanceOf(InventoryDomainException);
    await expect(
      useCase.execute({ variantId: VARIANT_ID, stockLocationId: 'back-store', quantity: 1 }),
    ).rejects.toMatchObject({ code: InventoryErrorCodeEnum.STOCK_LOCATION_INACTIVE });
  });

  it('rejects when the target location does not exist', async () => {
    await expect(
      useCase.execute({ variantId: VARIANT_ID, stockLocationId: 'ghost', quantity: 1 }),
    ).rejects.toMatchObject({ code: InventoryErrorCodeEnum.STOCK_LOCATION_NOT_FOUND });
  });

  it('routes the write through withInvalidation, resolving the mutated (variantId, stockLocationId)', async () => {
    await useCase.execute({ variantId: VARIANT_ID, quantity: 4, correlationId: CORRELATION_ID });

    expect(transaction.calls).toBe(1);
    expect(cache.invalidations).toHaveLength(1);
    expect(cache.invalidations[0].items).toEqual([
      { variantId: VARIANT_ID, stockLocationId: INVENTORY_DEFAULT_STOCK_LOCATION },
    ]);
    expect(cache.invalidations[0].opts).toMatchObject({ correlationId: CORRELATION_ID });
  });

  it('emits inventory.stock.received post-commit with the positive delta and new on-hand', async () => {
    await useCase.execute({
      variantId: VARIANT_ID,
      quantity: 8,
      actorId: 'staff-1',
      correlationId: CORRELATION_ID,
    });

    expect(publisher.received).toHaveLength(1);
    const [emitted] = publisher.received;
    expect(emitted.event.aggregateId).toBe(VARIANT_ID);
    expect(emitted.event.stockLocationId).toBe(INVENTORY_DEFAULT_STOCK_LOCATION);
    expect(emitted.event.quantityDelta).toBe(8);
    expect(emitted.event.newOnHand).toBe(8);
    expect(emitted.event.actorId).toBe('staff-1');
    expect(emitted.correlationId).toBe(CORRELATION_ID);

    // Receive never lowers on-hand, so it never fires the low-stock alert.
    expect(publisher.low).toHaveLength(0);
  });
});
