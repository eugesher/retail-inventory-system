import { PinoLogger } from 'nestjs-pino';

import {
  INVENTORY_DEFAULT_STOCK_LOCATION,
  StockMovementTypeEnum,
} from '@retail-inventory-system/contracts';
import { makePinoLoggerMock } from '@retail-inventory-system/observability/testing';

import { InventoryDomainException, InventoryErrorCodeEnum, StockLevel } from '../../../domain';
import { CommitSaleUseCase } from '../commit-sale.use-case';
import {
  ImmediateTransactionPort,
  InMemoryStockCache,
  InMemoryStockMovementRepository,
  InMemoryStockRepository,
  RecordingStockEventsPublisher,
} from './test-doubles';

const VARIANT_ID = 42;
const ORDER_ID = 7001;
const FULFILLMENT_ID = 'ful-aaaa-1111';
const CORRELATION_ID = 'corr-commit-1';
const LOCATION = INVENTORY_DEFAULT_STOCK_LOCATION;

describe('CommitSaleUseCase', () => {
  let repository: InMemoryStockRepository;
  let movements: InMemoryStockMovementRepository;
  let cache: InMemoryStockCache;
  let publisher: RecordingStockEventsPublisher;
  let transaction: ImmediateTransactionPort;
  let useCase: CommitSaleUseCase;

  beforeEach(() => {
    repository = new InMemoryStockRepository();
    movements = new InMemoryStockMovementRepository();
    cache = new InMemoryStockCache();
    publisher = new RecordingStockEventsPublisher();
    transaction = new ImmediateTransactionPort();
    useCase = new CommitSaleUseCase(
      transaction,
      repository,
      movements,
      cache,
      publisher,
      makePinoLoggerMock() as unknown as PinoLogger,
    );
  });

  const seedLevel = ({
    variantId = VARIANT_ID,
    onHand = 10,
    allocated = 4,
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

  const commit = (
    lines: { variantId: number; stockLocationId?: string; quantity: number }[],
    overrides: Partial<{ orderId: number; fulfillmentId: string; actorId: string }> = {},
  ): Promise<{ committed: { variantId: number; stockLocationId: string; quantity: number }[] }> =>
    useCase.execute({
      orderId: ORDER_ID,
      fulfillmentId: FULFILLMENT_ID,
      lines,
      correlationId: CORRELATION_ID,
      ...overrides,
    });

  it('decrements on-hand AND allocated and appends one strictly-negative sale movement per line', async () => {
    seedLevel({ onHand: 10, allocated: 4, reserved: 2 });

    const result = await commit([{ variantId: VARIANT_ID, quantity: 4 }]);

    expect(result).toEqual({
      committed: [{ variantId: VARIANT_ID, stockLocationId: LOCATION, quantity: 4 }],
    });

    // Both counters fell by the shipped quantity; reserved untouched; available
    // unchanged (both decremented counters subtract from it: 10−4−2=4 → 6−0−2=4).
    const level = await repository.findStockLevel(VARIANT_ID, LOCATION);
    expect(level?.quantityOnHand).toBe(6);
    expect(level?.quantityAllocated).toBe(0);
    expect(level?.quantityReserved).toBe(2);
    expect(level?.available).toBe(4);

    // Exactly one `sale` movement, strictly negative, referencing the fulfillment.
    expect(movements.appended).toHaveLength(1);
    const movement = movements.appended[0];
    expect(movement.type).toBe(StockMovementTypeEnum.SALE);
    expect(movement.quantity).toBe(-4);
    expect(movement.quantity).toBeLessThan(0); // the sign invariant, explicit
    expect(movement.referenceType).toBe('fulfillment');
    expect(movement.referenceId).toBe(FULFILLMENT_ID);
    expect(movement.reasonCode).toBeNull();
    expect(movement.actorId).toBeNull();

    // committed event + recorded event, both correlated.
    expect(publisher.committed).toHaveLength(1);
    expect(publisher.committed[0].event.aggregateId).toBe(VARIANT_ID);
    expect(publisher.committed[0].event.quantity).toBe(4);
    expect(publisher.committed[0].event.orderId).toBe(ORDER_ID);
    expect(publisher.committed[0].event.fulfillmentId).toBe(FULFILLMENT_ID);
    expect(publisher.committed[0].correlationId).toBe(CORRELATION_ID);
    expect(publisher.movementsRecorded).toHaveLength(1);

    // Cache invalidated for the touched (variant, location).
    expect(cache.invalidations).toHaveLength(1);
    expect(cache.invalidations[0].items).toEqual([
      { variantId: VARIANT_ID, stockLocationId: LOCATION },
    ]);

    // The movement joined the counter's transaction (same scope reference).
    expect(transaction.calls).toBe(1);
    expect(movements.appendScopes[0]).toBe(transaction.lastScope);
  });

  it('carries the actorId onto the sale movement', async () => {
    seedLevel({ onHand: 10, allocated: 4 });

    await commit([{ variantId: VARIANT_ID, quantity: 4 }], { actorId: 'staff-9' });

    expect(movements.appended[0].actorId).toBe('staff-9');
  });

  it('is idempotent on fulfillmentId — a replay decrements nothing and re-returns the lines', async () => {
    seedLevel({ onHand: 10, allocated: 4 });

    // First commit.
    await commit([{ variantId: VARIANT_ID, quantity: 4 }]);
    const afterFirst = await repository.findStockLevel(VARIANT_ID, LOCATION);
    expect(afterFirst?.quantityOnHand).toBe(6);
    expect(afterFirst?.quantityAllocated).toBe(0);
    expect(movements.appended).toHaveLength(1);
    const callsAfterFirst = transaction.calls;

    // Replay (same fulfillmentId): a sale movement already references it, so the
    // commit short-circuits — no second decrement, no new movement, no new
    // transaction, no cache invalidation — but it re-returns the request's lines.
    const replay = await commit([{ variantId: VARIANT_ID, quantity: 4 }]);
    expect(replay).toEqual({
      committed: [{ variantId: VARIANT_ID, stockLocationId: LOCATION, quantity: 4 }],
    });

    const afterReplay = await repository.findStockLevel(VARIANT_ID, LOCATION);
    expect(afterReplay?.quantityOnHand).toBe(6); // unchanged
    expect(afterReplay?.quantityAllocated).toBe(0); // unchanged
    expect(movements.appended).toHaveLength(1); // no second movement
    expect(transaction.calls).toBe(callsAfterFirst); // no second transaction
    expect(cache.invalidations).toHaveLength(1); // only the first commit invalidated
    // No second committed event fired on the replay path.
    expect(publisher.committed).toHaveLength(1);
  });

  it('commits multiple lines atomically with a sale movement + committed event per line', async () => {
    seedLevel({ variantId: 1, onHand: 10, allocated: 3 });
    seedLevel({ variantId: 2, onHand: 10, allocated: 5 });

    const result = await commit([
      { variantId: 1, quantity: 3 },
      { variantId: 2, quantity: 5 },
    ]);

    expect(result.committed).toHaveLength(2);
    expect((await repository.findStockLevel(1, LOCATION))?.quantityOnHand).toBe(7);
    expect((await repository.findStockLevel(1, LOCATION))?.quantityAllocated).toBe(0);
    expect((await repository.findStockLevel(2, LOCATION))?.quantityOnHand).toBe(5);
    expect((await repository.findStockLevel(2, LOCATION))?.quantityAllocated).toBe(0);
    expect(movements.appended).toHaveLength(2);
    expect(movements.appended.every((m) => m.type === StockMovementTypeEnum.SALE)).toBe(true);
    expect(publisher.committed).toHaveLength(2);
    expect(publisher.movementsRecorded).toHaveLength(2);
    expect(cache.invalidations[0].items).toEqual([
      { variantId: 1, stockLocationId: LOCATION },
      { variantId: 2, stockLocationId: LOCATION },
    ]);
  });

  it('an on-hand shortfall on a later line rolls the whole commit back (all-lines-atomic)', async () => {
    seedLevel({ variantId: 1, onHand: 10, allocated: 3 }); // line A fits
    // line B: allocated allows 5, but on-hand is only 2 → STOCK_RESULT_NEGATIVE.
    seedLevel({ variantId: 2, onHand: 2, allocated: 5 });

    const error = await commit([
      { variantId: 1, quantity: 3 },
      { variantId: 2, quantity: 5 },
    ]).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(InventoryDomainException);
    expect((error as InventoryDomainException).code).toBe(
      InventoryErrorCodeEnum.STOCK_RESULT_NEGATIVE,
    );
    // The earlier line's would-be ship never landed.
    expect((await repository.findStockLevel(1, LOCATION))?.quantityOnHand).toBe(10);
    expect((await repository.findStockLevel(1, LOCATION))?.quantityAllocated).toBe(3);
    expect(movements.appended).toHaveLength(0);
    expect(publisher.committed).toHaveLength(0);
    expect(cache.invalidations).toHaveLength(0);
  });

  it('an over-allocated drift surfaces as a plain Error (a 500, not a typed 409) and persists nothing', async () => {
    seedLevel({ onHand: 10, allocated: 2 });

    const error = await commit([{ variantId: VARIANT_ID, quantity: 3 }]).catch((e: unknown) => e);

    // Shipping more than is allocated is a counter drift — an internal bug, a 500.
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(InventoryDomainException);
    expect((await repository.findStockLevel(VARIANT_ID, LOCATION))?.quantityAllocated).toBe(2);
    expect(movements.appended).toHaveLength(0);
  });

  it('re-fires low-stock when the post-commit on-hand falls at/below the threshold', async () => {
    // Threshold is 5: ship 3 of 7 on-hand → 4 ≤ 5 fires the depletion alert.
    seedLevel({ onHand: 7, allocated: 3 });

    await commit([{ variantId: VARIANT_ID, quantity: 3 }]);

    expect(publisher.low).toHaveLength(1);
    expect(publisher.low[0].event.aggregateId).toBe(VARIANT_ID);
    expect(publisher.low[0].event.quantity).toBe(4);
  });

  it('does not fire low-stock when the post-commit on-hand stays above the threshold', async () => {
    // Ship 3 of 10 → 7 > 5: no alert.
    seedLevel({ onHand: 10, allocated: 4 });

    await commit([{ variantId: VARIANT_ID, quantity: 3 }]);

    expect(publisher.low).toHaveLength(0);
  });

  it('retries once on an optimistic conflict then succeeds', async () => {
    seedLevel({ onHand: 10, allocated: 4 });
    repository.conflictsBeforeSuccess = 1;

    await commit([{ variantId: VARIANT_ID, quantity: 4 }]);

    expect(transaction.calls).toBe(2);
    expect((await repository.findStockLevel(VARIANT_ID, LOCATION))?.quantityOnHand).toBe(6);
    // Exactly one movement despite the burned attempt (the append runs after the
    // version-checked persist, so a lost CAS leaves no orphan row).
    expect(movements.appended).toHaveLength(1);
  });

  it.each([0, -2, 1.5])(
    'rejects a non-positive / non-integer line quantity (%p)',
    async (quantity) => {
      seedLevel({ onHand: 10, allocated: 4 });

      await expect(commit([{ variantId: VARIANT_ID, quantity }])).rejects.toMatchObject({
        code: InventoryErrorCodeEnum.RESERVATION_QUANTITY_INVALID,
      });
      expect(cache.invalidations).toHaveLength(0);
      expect(movements.appended).toHaveLength(0);
    },
  );

  it('rejects an empty lines array', async () => {
    await expect(commit([])).rejects.toMatchObject({
      code: InventoryErrorCodeEnum.RESERVATION_QUANTITY_INVALID,
    });
  });
});
