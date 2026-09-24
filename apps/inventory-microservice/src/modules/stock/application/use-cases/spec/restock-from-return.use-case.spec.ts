import { PinoLogger } from 'nestjs-pino';

import {
  INVENTORY_DEFAULT_STOCK_LOCATION,
  StockMovementTypeEnum,
} from '@retail-inventory-system/contracts';
import { makePinoLoggerMock } from '@retail-inventory-system/observability/testing';

import { InventoryDomainException, InventoryErrorCodeEnum, StockLevel } from '../../../domain';
import { RestockFromReturnUseCase } from '../restock-from-return.use-case';
import {
  ImmediateTransactionPort,
  InMemoryStockCache,
  InMemoryStockMovementRepository,
  InMemoryStockRepository,
  RecordingStockEventsPublisher,
} from './test-doubles';

const VARIANT_ID = 42;
const RETURN_REQUEST_ID = 9001;
const RETURN_LINE_ID = 555;
const CORRELATION_ID = 'corr-restock-1';
const LOCATION = INVENTORY_DEFAULT_STOCK_LOCATION;

describe('RestockFromReturnUseCase', () => {
  let repository: InMemoryStockRepository;
  let movements: InMemoryStockMovementRepository;
  let cache: InMemoryStockCache;
  let publisher: RecordingStockEventsPublisher;
  let transaction: ImmediateTransactionPort;
  let useCase: RestockFromReturnUseCase;

  beforeEach(() => {
    repository = new InMemoryStockRepository();
    movements = new InMemoryStockMovementRepository();
    cache = new InMemoryStockCache();
    publisher = new RecordingStockEventsPublisher();
    transaction = new ImmediateTransactionPort();
    useCase = new RestockFromReturnUseCase(
      transaction,
      repository,
      movements,
      cache,
      publisher,
      5,
      makePinoLoggerMock() as unknown as PinoLogger,
    );
  });

  const seedLevel = ({
    variantId = VARIANT_ID,
    onHand = 10,
    allocated = 0,
    reserved = 0,
    version = 0,
  } = {}): void => {
    repository.seedLevel(
      new StockLevel({
        variantId,
        stockLocationId: LOCATION,
        quantityOnHand: onHand,
        quantityAllocated: allocated,
        quantityReserved: reserved,
        version,
      }),
    );
  };

  const restock = (
    lines: { returnLineId: number; variantId: number; stockLocationId: string; quantity: number }[],
    overrides: Partial<{ returnRequestId: number; actorId: string }> = {},
  ): Promise<{
    restocked: {
      returnLineId: number;
      variantId: number;
      stockLocationId: string;
      quantity: number;
    }[];
  }> =>
    useCase.execute({
      returnRequestId: RETURN_REQUEST_ID,
      lines,
      correlationId: CORRELATION_ID,
      ...overrides,
    });

  const line = (
    overrides: Partial<{ returnLineId: number; quantity: number }> = {},
  ): { returnLineId: number; variantId: number; stockLocationId: string; quantity: number } => ({
    returnLineId: RETURN_LINE_ID,
    variantId: VARIANT_ID,
    stockLocationId: LOCATION,
    quantity: 4,
    ...overrides,
  });

  it('increments on-hand and appends one strictly-positive return movement per line', async () => {
    seedLevel({ onHand: 10, allocated: 3, reserved: 2 });

    const result = await restock([line({ quantity: 4 })]);

    expect(result).toEqual({
      restocked: [
        {
          returnLineId: RETURN_LINE_ID,
          variantId: VARIANT_ID,
          stockLocationId: LOCATION,
          quantity: 4,
        },
      ],
    });

    const level = await repository.findStockLevel(VARIANT_ID, LOCATION);
    expect(level?.quantityOnHand).toBe(14);
    expect(level?.quantityAllocated).toBe(3);
    expect(level?.quantityReserved).toBe(2);
    expect(level?.available).toBe(9);

    expect(movements.appended).toHaveLength(1);
    const movement = movements.appended[0];
    expect(movement.type).toBe(StockMovementTypeEnum.RETURN);
    expect(movement.quantity).toBe(4);
    expect(movement.quantity).toBeGreaterThan(0);
    expect(movement.referenceType).toBe('return-request');
    expect(movement.referenceId).toBe(String(RETURN_REQUEST_ID));
    expect(movement.reasonCode).toBeNull();
    expect(movement.actorId).toBeNull();

    expect(publisher.returned).toHaveLength(1);
    expect(publisher.returned[0].event.aggregateId).toBe(VARIANT_ID);
    expect(publisher.returned[0].event.quantity).toBe(4);
    expect(publisher.returned[0].event.returnRequestId).toBe(RETURN_REQUEST_ID);
    expect(publisher.returned[0].event.returnLineId).toBe(RETURN_LINE_ID);
    expect(publisher.returned[0].correlationId).toBe(CORRELATION_ID);
    expect(publisher.movementsRecorded).toHaveLength(1);

    expect(cache.invalidations).toHaveLength(1);
    expect(cache.invalidations[0].items).toEqual([
      { variantId: VARIANT_ID, stockLocationId: LOCATION },
    ]);

    expect(transaction.calls).toBe(1);
    expect(movements.appendScopes[0]).toBe(transaction.lastScope);
  });

  it('carries the actorId onto the return movement', async () => {
    seedLevel({ onHand: 10 });

    await restock([line({ quantity: 4 })], { actorId: 'warehouse-7' });

    expect(movements.appended[0].actorId).toBe('warehouse-7');
  });

  it('lazy-inits a missing level (a returned variant with no level at the location)', async () => {
    const result = await restock([line({ quantity: 5 })]);

    expect(result.restocked).toHaveLength(1);
    const level = await repository.findStockLevel(VARIANT_ID, LOCATION);
    expect(level?.quantityOnHand).toBe(5);
    expect(level?.quantityAllocated).toBe(0);
    expect(level?.quantityReserved).toBe(0);
    expect(movements.appended).toHaveLength(1);
    expect(movements.appended[0].type).toBe(StockMovementTypeEnum.RETURN);
  });

  it('is idempotent on returnRequestId — a replay increments nothing and re-returns the lines', async () => {
    seedLevel({ onHand: 10 });

    await restock([line({ quantity: 4 })]);
    const afterFirst = await repository.findStockLevel(VARIANT_ID, LOCATION);
    expect(afterFirst?.quantityOnHand).toBe(14);
    expect(movements.appended).toHaveLength(1);
    const callsAfterFirst = transaction.calls;

    const replay = await restock([line({ quantity: 4 })]);
    expect(replay).toEqual({
      restocked: [
        {
          returnLineId: RETURN_LINE_ID,
          variantId: VARIANT_ID,
          stockLocationId: LOCATION,
          quantity: 4,
        },
      ],
    });

    const afterReplay = await repository.findStockLevel(VARIANT_ID, LOCATION);
    expect(afterReplay?.quantityOnHand).toBe(14);
    expect(movements.appended).toHaveLength(1);
    expect(transaction.calls).toBe(callsAfterFirst);
    expect(cache.invalidations).toHaveLength(1);
    expect(publisher.returned).toHaveLength(1);
  });

  it('restocks multiple lines atomically with a return movement + returned event per line', async () => {
    seedLevel({ variantId: 1, onHand: 10 });
    seedLevel({ variantId: 2, onHand: 20 });

    const result = await restock([
      { returnLineId: 11, variantId: 1, stockLocationId: LOCATION, quantity: 3 },
      { returnLineId: 22, variantId: 2, stockLocationId: LOCATION, quantity: 5 },
    ]);

    expect(result.restocked).toHaveLength(2);
    expect((await repository.findStockLevel(1, LOCATION))?.quantityOnHand).toBe(13);
    expect((await repository.findStockLevel(2, LOCATION))?.quantityOnHand).toBe(25);
    expect(movements.appended).toHaveLength(2);
    expect(movements.appended.every((m) => m.type === StockMovementTypeEnum.RETURN)).toBe(true);
    expect(movements.appended.every((m) => m.quantity > 0)).toBe(true);
    expect(publisher.returned).toHaveLength(2);
    expect(publisher.movementsRecorded).toHaveLength(2);
    expect(cache.invalidations[0].items).toEqual([
      { variantId: 1, stockLocationId: LOCATION },
      { variantId: 2, stockLocationId: LOCATION },
    ]);
  });

  it('rolls the whole restock back when the write conflict exhausts the retry budget (all-lines-atomic)', async () => {
    seedLevel({ variantId: 1, onHand: 10 });
    seedLevel({ variantId: 2, onHand: 20 });
    repository.conflictsBeforeSuccess = 5;

    const error = await restock([
      { returnLineId: 11, variantId: 1, stockLocationId: LOCATION, quantity: 3 },
      { returnLineId: 22, variantId: 2, stockLocationId: LOCATION, quantity: 5 },
    ]).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(InventoryDomainException);
    expect((error as InventoryDomainException).code).toBe(
      InventoryErrorCodeEnum.STOCK_WRITE_CONFLICT,
    );
    expect((await repository.findStockLevel(1, LOCATION))?.quantityOnHand).toBe(10);
    expect((await repository.findStockLevel(2, LOCATION))?.quantityOnHand).toBe(20);
    expect(movements.appended).toHaveLength(0);
    expect(publisher.returned).toHaveLength(0);
    expect(cache.invalidations).toHaveLength(0);
  });

  it('retries once on an optimistic conflict then succeeds with exactly one movement', async () => {
    seedLevel({ onHand: 10 });
    repository.conflictsBeforeSuccess = 1;

    await restock([line({ quantity: 4 })]);

    expect(transaction.calls).toBe(2);
    expect((await repository.findStockLevel(VARIANT_ID, LOCATION))?.quantityOnHand).toBe(14);
    expect(movements.appended).toHaveLength(1);
  });

  it('never fires low-stock — a restock only raises on-hand', async () => {
    seedLevel({ onHand: 1 });

    await restock([line({ quantity: 2 })]);

    expect((await repository.findStockLevel(VARIANT_ID, LOCATION))?.quantityOnHand).toBe(3);
    expect(publisher.low).toHaveLength(0);
  });

  it.each([0, -2, 1.5])(
    'rejects a non-positive / non-integer line quantity (%p)',
    async (quantity) => {
      seedLevel({ onHand: 10 });

      await expect(restock([line({ quantity })])).rejects.toMatchObject({
        code: InventoryErrorCodeEnum.RESERVATION_QUANTITY_INVALID,
      });
      expect(cache.invalidations).toHaveLength(0);
      expect(movements.appended).toHaveLength(0);
    },
  );

  it('rejects an empty lines array', async () => {
    await expect(restock([])).rejects.toMatchObject({
      code: InventoryErrorCodeEnum.RESERVATION_QUANTITY_INVALID,
    });
  });

  describe('losing a concurrent race must be a successful no-op, never a throw', () => {
    it('translates the ledger duplicate-key error into the same replay result', async () => {
      seedLevel({ onHand: 10 });
      movements.failNextAppendWithDuplicateEntry();

      const result = await restock([line({ quantity: 2 })]);

      expect(result.restocked).toHaveLength(1);
      expect(movements.appended).toHaveLength(0);
    });
  });

  it('rejects two lines that share a (variant, location) level', async () => {
    seedLevel({ onHand: 10 });

    await expect(
      restock([line({ quantity: 2 }), line({ returnLineId: RETURN_LINE_ID + 1, quantity: 1 })]),
    ).rejects.toMatchObject({ code: InventoryErrorCodeEnum.RESERVATION_QUANTITY_INVALID });

    expect(movements.appended).toHaveLength(0);
    expect(cache.invalidations).toHaveLength(0);
  });
});
