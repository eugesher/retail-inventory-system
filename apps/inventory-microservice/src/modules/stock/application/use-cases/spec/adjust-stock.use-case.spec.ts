import { PinoLogger } from 'nestjs-pino';

import {
  INVENTORY_DEFAULT_LOW_STOCK_THRESHOLD,
  INVENTORY_DEFAULT_STOCK_LOCATION,
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
import { AdjustStockUseCase } from '../adjust-stock.use-case';
import {
  ImmediateTransactionPort,
  InMemoryStockCache,
  InMemoryStockMovementRepository,
  InMemoryStockRepository,
  RecordingStockEventsPublisher,
} from './test-doubles';

const VARIANT_ID = 42;
const CORRELATION_ID = 'corr-adjust-1';

const activeLocation = (id = INVENTORY_DEFAULT_STOCK_LOCATION): StockLocation =>
  new StockLocation({
    id,
    name: `Loc ${id}`,
    code: id.toUpperCase(),
    type: StockLocationTypeEnum.WAREHOUSE,
  });

const seedLevel = (repository: InMemoryStockRepository, quantityOnHand: number): void => {
  repository.seedLevel(
    new StockLevel({
      variantId: VARIANT_ID,
      stockLocationId: INVENTORY_DEFAULT_STOCK_LOCATION,
      quantityOnHand,
      quantityAllocated: 0,
      quantityReserved: 0,
      version: 0,
    }),
  );
};

describe('AdjustStockUseCase', () => {
  let repository: InMemoryStockRepository;
  let movements: InMemoryStockMovementRepository;
  let cache: InMemoryStockCache;
  let publisher: RecordingStockEventsPublisher;
  let transaction: ImmediateTransactionPort;
  let useCase: AdjustStockUseCase;

  beforeEach(() => {
    repository = new InMemoryStockRepository();
    movements = new InMemoryStockMovementRepository();
    cache = new InMemoryStockCache();
    publisher = new RecordingStockEventsPublisher();
    transaction = new ImmediateTransactionPort();
    repository.seedLocation(activeLocation());
    useCase = new AdjustStockUseCase(
      transaction,
      repository,
      movements,
      cache,
      publisher,
      makePinoLoggerMock() as unknown as PinoLogger,
    );
  });

  it('applies a positive signed delta and returns the updated view', async () => {
    seedLevel(repository, 10);

    const view = await useCase.execute({
      variantId: VARIANT_ID,
      quantityDelta: 5,
      reasonCode: 'cycle-count',
      correlationId: CORRELATION_ID,
    });

    expect(view.quantityOnHand).toBe(15);
    expect(view.available).toBe(15);
  });

  it('applies a negative signed delta', async () => {
    seedLevel(repository, 10);

    const view = await useCase.execute({
      variantId: VARIANT_ID,
      quantityDelta: -3,
      reasonCode: 'damaged',
    });

    expect(view.quantityOnHand).toBe(7);
  });

  it.each(['', '   '])('rejects a missing/blank reasonCode (%p)', async (reasonCode) => {
    seedLevel(repository, 10);

    await expect(
      useCase.execute({ variantId: VARIANT_ID, quantityDelta: -1, reasonCode }),
    ).rejects.toMatchObject({ code: InventoryErrorCodeEnum.STOCK_ADJUSTMENT_REASON_REQUIRED });

    expect(publisher.adjusted).toHaveLength(0);
    expect(cache.invalidations).toHaveLength(0);
  });

  it.each([0, 1.5])('rejects a zero / non-integer delta (%p)', async (quantityDelta) => {
    seedLevel(repository, 10);

    await expect(
      useCase.execute({ variantId: VARIANT_ID, quantityDelta, reasonCode: 'x' }),
    ).rejects.toMatchObject({ code: InventoryErrorCodeEnum.STOCK_ADJUSTMENT_DELTA_INVALID });
  });

  it('rejects a delta that would drive on-hand below zero — no save, no event, no invalidation', async () => {
    seedLevel(repository, 3);

    await expect(
      useCase.execute({ variantId: VARIANT_ID, quantityDelta: -4, reasonCode: 'damaged' }),
    ).rejects.toBeInstanceOf(InventoryDomainException);
    await expect(
      useCase.execute({ variantId: VARIANT_ID, quantityDelta: -100, reasonCode: 'damaged' }),
    ).rejects.toMatchObject({ code: InventoryErrorCodeEnum.STOCK_RESULT_NEGATIVE });

    // The seeded level is unchanged (the rejection happens before save), and no
    // movement, event, or cache invalidation fired.
    const persisted = await repository.findStockLevel(VARIANT_ID, INVENTORY_DEFAULT_STOCK_LOCATION);
    expect(persisted?.quantityOnHand).toBe(3);
    expect(movements.appended).toHaveLength(0);
    expect(publisher.adjusted).toHaveLength(0);
    expect(publisher.low).toHaveLength(0);
    expect(publisher.movementsRecorded).toHaveLength(0);
    expect(cache.invalidations).toHaveLength(0);
  });

  it('routes the write through withInvalidation and emits inventory.stock.adjusted', async () => {
    seedLevel(repository, 10);

    await useCase.execute({
      variantId: VARIANT_ID,
      quantityDelta: -3,
      reasonCode: 'damaged',
      actorId: 'staff-9',
      correlationId: CORRELATION_ID,
    });

    expect(transaction.calls).toBe(1);
    expect(cache.invalidations[0].items).toEqual([
      { variantId: VARIANT_ID, stockLocationId: INVENTORY_DEFAULT_STOCK_LOCATION },
    ]);

    expect(publisher.adjusted).toHaveLength(1);
    const [emitted] = publisher.adjusted;
    expect(emitted.event.aggregateId).toBe(VARIANT_ID);
    expect(emitted.event.quantityDelta).toBe(-3);
    expect(emitted.event.reasonCode).toBe('damaged');
    expect(emitted.event.newOnHand).toBe(7);
    expect(emitted.event.actorId).toBe('staff-9');
    expect(emitted.correlationId).toBe(CORRELATION_ID);
  });

  it('emits inventory.stock.low when the post-commit on-hand falls at/below the threshold', async () => {
    // Threshold is 5; 10 − 6 = 4 ≤ 5 → the low-stock alert fires.
    seedLevel(repository, INVENTORY_DEFAULT_LOW_STOCK_THRESHOLD + 5);

    await useCase.execute({
      variantId: VARIANT_ID,
      quantityDelta: -6,
      reasonCode: 'shrinkage',
      correlationId: CORRELATION_ID,
    });

    expect(publisher.low).toHaveLength(1);
    const [low] = publisher.low;
    expect(low.event.aggregateId).toBe(VARIANT_ID);
    expect(low.event.stockLocationId).toBe(INVENTORY_DEFAULT_STOCK_LOCATION);
    expect(low.event.quantity).toBe(INVENTORY_DEFAULT_LOW_STOCK_THRESHOLD - 1);
    expect(low.event.threshold).toBe(INVENTORY_DEFAULT_LOW_STOCK_THRESHOLD);
  });

  it('does NOT emit inventory.stock.low when the post-commit on-hand stays above the threshold', async () => {
    // Threshold is 5; 10 − 3 = 7 > 5 → no low-stock alert.
    seedLevel(repository, 10);

    await useCase.execute({ variantId: VARIANT_ID, quantityDelta: -3, reasonCode: 'damaged' });

    expect(publisher.adjusted).toHaveLength(1);
    expect(publisher.low).toHaveLength(0);
  });

  it('appends a signed adjustment movement with the reasonCode + actorId inside the counter transaction', async () => {
    seedLevel(repository, 10);

    await useCase.execute({
      variantId: VARIANT_ID,
      quantityDelta: -3,
      reasonCode: 'damaged',
      actorId: 'staff-9',
      correlationId: CORRELATION_ID,
    });

    // Exactly one `adjustment` ledger row carrying the SIGNED delta + the reason.
    expect(movements.appended).toHaveLength(1);
    const [movement] = movements.appended;
    expect(movement.type).toBe(StockMovementTypeEnum.ADJUSTMENT);
    expect(movement.quantity).toBe(-3);
    expect(movement.reasonCode).toBe('damaged');
    expect(movement.variantId).toBe(VARIANT_ID);
    expect(movement.stockLocationId).toBe(INVENTORY_DEFAULT_STOCK_LOCATION);
    expect(movement.actorId).toBe('staff-9');
    expect(movement.referenceType).toBeNull();
    expect(movement.referenceId).toBeNull();

    // It joined the counter's transaction (same scope).
    expect(movements.appendScopes[0]).toBe(transaction.lastScope);

    // The recorded event fires post-commit alongside adjusted.
    expect(publisher.movementsRecorded).toHaveLength(1);
    expect(publisher.movementsRecorded[0].movement).toBe(movement);
    expect(publisher.movementsRecorded[0].correlationId).toBe(CORRELATION_ID);
  });

  it('records a positive adjustment movement for a positive delta', async () => {
    seedLevel(repository, 10);

    await useCase.execute({ variantId: VARIANT_ID, quantityDelta: 5, reasonCode: 'found' });

    expect(movements.appended).toHaveLength(1);
    expect(movements.appended[0].quantity).toBe(5);
    expect(movements.appended[0].reasonCode).toBe('found');
  });

  it('appends exactly ONE movement across an optimistic retry (not one per attempt)', async () => {
    seedLevel(repository, 10);
    // The first two persists lose the CAS; the append sits after the persist, so a
    // losing attempt never reaches it — only the third (winning) attempt appends.
    repository.conflictsBeforeSuccess = 2;

    await useCase.execute({ variantId: VARIANT_ID, quantityDelta: -3, reasonCode: 'damaged' });

    expect(transaction.calls).toBe(3);
    expect(movements.appended).toHaveLength(1);
    expect(publisher.movementsRecorded).toHaveLength(1);
  });

  it('swallows a recorded-event publish failure without failing the RPC (write already committed)', async () => {
    seedLevel(repository, 10);
    jest
      .spyOn(publisher, 'publishStockMovementRecorded')
      .mockRejectedValueOnce(new Error('broker down'));

    const view = await useCase.execute({
      variantId: VARIANT_ID,
      quantityDelta: -3,
      reasonCode: 'damaged',
    });

    // The adjust still succeeds and the ledger row still landed in the tx.
    expect(view.quantityOnHand).toBe(7);
    expect(movements.appended).toHaveLength(1);
  });
});
