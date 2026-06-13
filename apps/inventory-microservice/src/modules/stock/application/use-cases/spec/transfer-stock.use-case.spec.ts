import { PinoLogger } from 'nestjs-pino';

import {
  INVENTORY_DEFAULT_LOW_STOCK_THRESHOLD,
  INVENTORY_DEFAULT_STOCK_LOCATION,
  IStockTransferPayload,
  IStockTransferResult,
  StockMovementTypeEnum,
} from '@retail-inventory-system/contracts';
import { makePinoLoggerMock } from '@retail-inventory-system/observability/testing';

import {
  InventoryDomainException,
  InventoryErrorCodeEnum,
  StockLevel,
  StockLocation,
  StockLocationTypeEnum,
} from '../../../domain';
import { TransferStockUseCase } from '../transfer-stock.use-case';
import {
  ImmediateTransactionPort,
  InMemoryStockCache,
  InMemoryStockMovementRepository,
  InMemoryStockRepository,
  RecordingStockEventsPublisher,
} from './test-doubles';

const VARIANT_ID = 42;
const FROM = INVENTORY_DEFAULT_STOCK_LOCATION; // 'default-warehouse'
const TO = 'backup-store';
const CORRELATION_ID = 'corr-transfer-1';

const location = (id: string, active = true): StockLocation =>
  new StockLocation({
    id,
    name: `Loc ${id}`,
    code: id.toUpperCase(),
    type: StockLocationTypeEnum.WAREHOUSE,
    active,
  });

const seedLevel = (
  repository: InMemoryStockRepository,
  stockLocationId: string,
  quantityOnHand: number,
): void => {
  repository.seedLevel(
    new StockLevel({
      variantId: VARIANT_ID,
      stockLocationId,
      quantityOnHand,
      quantityAllocated: 0,
      quantityReserved: 0,
      version: 0,
    }),
  );
};

describe('TransferStockUseCase', () => {
  let repository: InMemoryStockRepository;
  let movements: InMemoryStockMovementRepository;
  let cache: InMemoryStockCache;
  let publisher: RecordingStockEventsPublisher;
  let transaction: ImmediateTransactionPort;
  let useCase: TransferStockUseCase;

  beforeEach(() => {
    repository = new InMemoryStockRepository();
    movements = new InMemoryStockMovementRepository();
    cache = new InMemoryStockCache();
    publisher = new RecordingStockEventsPublisher();
    transaction = new ImmediateTransactionPort();
    repository.seedLocation(location(FROM));
    repository.seedLocation(location(TO));
    useCase = new TransferStockUseCase(
      transaction,
      repository,
      movements,
      cache,
      publisher,
      makePinoLoggerMock() as unknown as PinoLogger,
    );
  });

  // The default transfer is variant 42, 5 units default-warehouse → backup-store,
  // with the correlation id threaded. Each test overrides only what it asserts on.
  const transfer = (
    overrides: Partial<IStockTransferPayload> = {},
  ): Promise<IStockTransferResult> =>
    useCase.execute({
      variantId: VARIANT_ID,
      fromLocationId: FROM,
      toLocationId: TO,
      quantity: 5,
      correlationId: CORRELATION_ID,
      ...overrides,
    });

  it('moves on-hand source→destination (lazy-initing the destination) and returns both views', async () => {
    seedLevel(repository, FROM, 20);
    // No destination level seeded — the transfer lazy-inits it to 0, then credits it.

    const result = await transfer({ actorId: 'staff-9' });

    expect(result.from.stockLocationId).toBe(FROM);
    expect(result.from.quantityOnHand).toBe(15);
    expect(result.from.available).toBe(15);
    expect(result.to.stockLocationId).toBe(TO);
    expect(result.to.quantityOnHand).toBe(5);
    expect(result.to.available).toBe(5);

    // One transaction; the persisted source and destination rows reflect the move.
    expect(transaction.calls).toBe(1);
    const persistedSource = await repository.findStockLevel(VARIANT_ID, FROM);
    const persistedDest = await repository.findStockLevel(VARIANT_ID, TO);
    expect(persistedSource?.quantityOnHand).toBe(15);
    expect(persistedDest?.quantityOnHand).toBe(5);
  });

  it('appends exactly TWO paired adjustment movements sharing one transfer reference, both in the counter tx', async () => {
    seedLevel(repository, FROM, 20);

    await transfer({ actorId: 'staff-9' });

    expect(movements.appended).toHaveLength(2);
    const [out, incoming] = movements.appended;

    // Source leg: a negative `adjustment`, reason transfer-out, at the source.
    expect(out.type).toBe(StockMovementTypeEnum.ADJUSTMENT);
    expect(out.quantity).toBe(-5);
    expect(out.reasonCode).toBe('transfer-out');
    expect(out.stockLocationId).toBe(FROM);
    expect(out.referenceType).toBe('transfer');
    expect(out.actorId).toBe('staff-9');

    // Destination leg: a positive `adjustment`, reason transfer-in, at the destination.
    expect(incoming.type).toBe(StockMovementTypeEnum.ADJUSTMENT);
    expect(incoming.quantity).toBe(5);
    expect(incoming.reasonCode).toBe('transfer-in');
    expect(incoming.stockLocationId).toBe(TO);
    expect(incoming.referenceType).toBe('transfer');
    expect(incoming.actorId).toBe('staff-9');

    // The pairing key: both legs carry the SAME non-null transfer reference id.
    expect(out.referenceId).not.toBeNull();
    expect(out.referenceId).toBe(incoming.referenceId);

    // Both appends joined the counter's transaction (same scope).
    expect(movements.appendScopes[0]).toBe(transaction.lastScope);
    expect(movements.appendScopes[1]).toBe(transaction.lastScope);
  });

  it('invalidates the cache for BOTH locations and records both movements post-commit', async () => {
    seedLevel(repository, FROM, 20);

    await transfer();

    expect(cache.invalidations).toHaveLength(1);
    expect(cache.invalidations[0].items).toEqual([
      { variantId: VARIANT_ID, stockLocationId: FROM },
      { variantId: VARIANT_ID, stockLocationId: TO },
    ]);

    // One recorded event per appended ledger row, correlation id threaded.
    expect(publisher.movementsRecorded).toHaveLength(2);
    expect(publisher.movementsRecorded[0].movement).toBe(movements.appended[0]);
    expect(publisher.movementsRecorded[1].movement).toBe(movements.appended[1]);
    expect(publisher.movementsRecorded[0].correlationId).toBe(CORRELATION_ID);
  });

  it('attributes a system transfer (no actorId) with null actor on both legs', async () => {
    seedLevel(repository, FROM, 20);

    await transfer();

    expect(movements.appended[0].actorId).toBeNull();
    expect(movements.appended[1].actorId).toBeNull();
  });

  it('re-runs the whole two-leg write on an optimistic conflict, appending exactly two movements once', async () => {
    seedLevel(repository, FROM, 20);
    // The first two persists lose the CAS; the appends sit after the persists, so a
    // losing attempt never reaches them — only the third (winning) attempt appends.
    repository.conflictsBeforeSuccess = 2;

    const result = await transfer();

    expect(transaction.calls).toBe(3);
    expect(movements.appended).toHaveLength(2);
    expect(publisher.movementsRecorded).toHaveLength(2);
    expect(result.from.quantityOnHand).toBe(15);
    expect(result.to.quantityOnHand).toBe(5);
  });

  it('leaves NO partial state when the optimistic write exhausts its retry budget', async () => {
    seedLevel(repository, FROM, 20);
    // Every attempt's persist loses the race (the conflict rejects before the map is
    // mutated), so neither counter moves and nothing is appended — proof the two
    // persists + two appends are one unit of work, not a half-applied transfer.
    repository.conflictsBeforeSuccess = 5;

    await expect(transfer()).rejects.toMatchObject({
      code: InventoryErrorCodeEnum.STOCK_WRITE_CONFLICT,
    });

    const persistedSource = await repository.findStockLevel(VARIANT_ID, FROM);
    expect(persistedSource?.quantityOnHand).toBe(20);
    expect(await repository.findStockLevel(VARIANT_ID, TO)).toBeNull();
    expect(movements.appended).toHaveLength(0);
    expect(publisher.movementsRecorded).toHaveLength(0);
    expect(cache.invalidations).toHaveLength(0);
  });

  it.each([
    ['an empty source (no level)', undefined],
    ['a short source', 3],
  ])(
    'rejects %s with STOCK_RESULT_NEGATIVE — nothing appended or invalidated',
    async (_label, seed) => {
      if (seed !== undefined) {
        seedLevel(repository, FROM, seed);
      }

      await expect(transfer()).rejects.toMatchObject({
        code: InventoryErrorCodeEnum.STOCK_RESULT_NEGATIVE,
      });

      // The destination was never persisted and no ledger row / invalidation fired.
      expect(await repository.findStockLevel(VARIANT_ID, TO)).toBeNull();
      expect(movements.appended).toHaveLength(0);
      expect(cache.invalidations).toHaveLength(0);
    },
  );

  it('rejects a same-location transfer with TRANSFER_SAME_LOCATION', async () => {
    seedLevel(repository, FROM, 20);

    await expect(transfer({ toLocationId: FROM })).rejects.toMatchObject({
      code: InventoryErrorCodeEnum.TRANSFER_SAME_LOCATION,
    });

    expect(movements.appended).toHaveLength(0);
  });

  it.each([0, -1, 1.5])('rejects a non-positive / non-integer quantity (%p)', async (quantity) => {
    seedLevel(repository, FROM, 20);

    await expect(transfer({ quantity })).rejects.toMatchObject({
      code: InventoryErrorCodeEnum.TRANSFER_QUANTITY_INVALID,
    });
  });

  it('rejects an unknown destination location with STOCK_LOCATION_NOT_FOUND', async () => {
    seedLevel(repository, FROM, 20);

    await expect(transfer({ toLocationId: 'ghost-store' })).rejects.toMatchObject({
      code: InventoryErrorCodeEnum.STOCK_LOCATION_NOT_FOUND,
    });
  });

  it('rejects an inactive destination location with STOCK_LOCATION_INACTIVE', async () => {
    seedLevel(repository, FROM, 20);
    repository.seedLocation(location('closed-store', false));

    await expect(transfer({ toLocationId: 'closed-store' })).rejects.toBeInstanceOf(
      InventoryDomainException,
    );
    await expect(transfer({ toLocationId: 'closed-store' })).rejects.toMatchObject({
      code: InventoryErrorCodeEnum.STOCK_LOCATION_INACTIVE,
    });
  });

  it('emits inventory.stock.low for the SOURCE when its post-transfer on-hand falls at/below the threshold', async () => {
    // Threshold is 5; source 10 − 6 = 4 ≤ 5 → the low-stock alert fires for the source.
    seedLevel(repository, FROM, INVENTORY_DEFAULT_LOW_STOCK_THRESHOLD + 5);

    await transfer({ quantity: 6 });

    expect(publisher.low).toHaveLength(1);
    const [low] = publisher.low;
    // The alert is for the SOURCE location, never the destination (which only gained).
    expect(low.event.stockLocationId).toBe(FROM);
    expect(low.event.aggregateId).toBe(VARIANT_ID);
    expect(low.event.quantity).toBe(INVENTORY_DEFAULT_LOW_STOCK_THRESHOLD - 1);
  });

  it('does NOT emit inventory.stock.low when the source stays above the threshold', async () => {
    seedLevel(repository, FROM, 20);

    await transfer();

    expect(publisher.low).toHaveLength(0);
  });

  it('swallows a recorded-event publish failure without failing the RPC (transfer already committed)', async () => {
    seedLevel(repository, FROM, 20);
    jest
      .spyOn(publisher, 'publishStockMovementRecorded')
      .mockRejectedValueOnce(new Error('broker down'));

    const result = await transfer();

    // The transfer still succeeds and both ledger rows still landed in the tx.
    expect(result.from.quantityOnHand).toBe(15);
    expect(result.to.quantityOnHand).toBe(5);
    expect(movements.appended).toHaveLength(2);
  });
});
