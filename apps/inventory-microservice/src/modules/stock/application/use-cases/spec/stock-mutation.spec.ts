import { PinoLogger } from 'nestjs-pino';

import {
  INVENTORY_DEFAULT_STOCK_LOCATION,
  StockMovementTypeEnum,
} from '@retail-inventory-system/contracts';
import { makePinoLoggerMock } from '@retail-inventory-system/observability/testing';

import {
  InventoryDomainException,
  InventoryErrorCodeEnum,
  StockLevel,
  StockMovement,
} from '../../../domain';
import { applyOnHandChange, IStockMutationDeps } from '../stock-mutation';
import {
  ImmediateTransactionPort,
  InMemoryStockCache,
  InMemoryStockMovementRepository,
  InMemoryStockRepository,
} from './test-doubles';

const VARIANT_ID = 42;
const LOCATION = INVENTORY_DEFAULT_STOCK_LOCATION;
const CORRELATION_ID = 'corr-mutation-1';

const seedLevel = (
  repository: InMemoryStockRepository,
  quantityOnHand: number,
  version = 0,
): void => {
  repository.seedLevel(
    new StockLevel({
      variantId: VARIANT_ID,
      stockLocationId: LOCATION,
      quantityOnHand,
      quantityAllocated: 0,
      quantityReserved: 0,
      version,
    }),
  );
};

describe('applyOnHandChange (shared stock mutator)', () => {
  let repository: InMemoryStockRepository;
  let movements: InMemoryStockMovementRepository;
  let cache: InMemoryStockCache;
  let transaction: ImmediateTransactionPort;
  let deps: IStockMutationDeps;

  beforeEach(() => {
    repository = new InMemoryStockRepository();
    movements = new InMemoryStockMovementRepository();
    cache = new InMemoryStockCache();
    transaction = new ImmediateTransactionPort();
    deps = {
      transactionPort: transaction,
      repository,
      movementRepository: movements,
      stockCache: cache,
      logger: makePinoLoggerMock() as unknown as PinoLogger,
      maxAttempts: 5,
    };
  });

  it('applies the delta to an existing level and invalidates once post-commit', async () => {
    seedLevel(repository, 10);

    const { level } = await applyOnHandChange(deps, {
      variantId: VARIANT_ID,
      stockLocationId: LOCATION,
      delta: 5,
      correlationId: CORRELATION_ID,
    });

    expect(level.quantityOnHand).toBe(15);
    expect(transaction.calls).toBe(1);
    expect(cache.invalidations).toHaveLength(1);
    expect(cache.invalidations[0].items).toEqual([
      { variantId: VARIANT_ID, stockLocationId: LOCATION },
    ]);
    expect(cache.invalidations[0].opts).toMatchObject({ correlationId: CORRELATION_ID });
  });

  it('lazy-initializes a missing level (first-touch) then applies the delta', async () => {
    const { level } = await applyOnHandChange(deps, {
      variantId: 999,
      stockLocationId: LOCATION,
      delta: 7,
    });

    expect(level.quantityOnHand).toBe(7);
    const persisted = await repository.findStockLevel(999, LOCATION);
    expect(persisted?.quantityOnHand).toBe(7);
  });

  it('retries on an optimistic conflict and applies the delta exactly once (no double-apply)', async () => {
    seedLevel(repository, 10);
    repository.conflictsBeforeSuccess = 2;

    const { level } = await applyOnHandChange(deps, {
      variantId: VARIANT_ID,
      stockLocationId: LOCATION,
      delta: 5,
    });

    expect(level.quantityOnHand).toBe(15);
    expect(transaction.calls).toBe(3);
    expect(cache.invalidations).toHaveLength(1);
  });

  it('does NOT retry a domain rejection (below-zero) and performs no invalidation', async () => {
    seedLevel(repository, 3);

    await expect(
      applyOnHandChange(deps, { variantId: VARIANT_ID, stockLocationId: LOCATION, delta: -5 }),
    ).rejects.toMatchObject({ code: InventoryErrorCodeEnum.STOCK_RESULT_NEGATIVE });

    expect(transaction.calls).toBe(1);
    expect(cache.invalidations).toHaveLength(0);
    const persisted = await repository.findStockLevel(VARIANT_ID, LOCATION);
    expect(persisted?.quantityOnHand).toBe(3);
  });

  it('exhausts the injected retry budget and surfaces a STOCK_WRITE_CONFLICT (409)', async () => {
    seedLevel(repository, 10);
    repository.conflictsBeforeSuccess = 99;

    const error = await applyOnHandChange(
      { ...deps, maxAttempts: 4 },
      { variantId: VARIANT_ID, stockLocationId: LOCATION, delta: 5 },
    ).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(InventoryDomainException);
    expect((error as InventoryDomainException).code).toBe(
      InventoryErrorCodeEnum.STOCK_WRITE_CONFLICT,
    );
    expect(transaction.calls).toBe(4);
    expect(cache.invalidations).toHaveLength(0);
  });

  describe('honors the injected OCC retry budget (OCC_RETRY_ATTEMPTS, ADR-036)', () => {
    it('succeeds when conflicts stay within budget (budget 2, one conflict then success)', async () => {
      seedLevel(repository, 10);
      repository.conflictsBeforeSuccess = 1;

      const { level } = await applyOnHandChange(
        { ...deps, maxAttempts: 2 },
        { variantId: VARIANT_ID, stockLocationId: LOCATION, delta: 5 },
      );

      expect(level.quantityOnHand).toBe(15);
      expect(transaction.calls).toBe(2);
      expect(cache.invalidations).toHaveLength(1);
    });

    it('exhausts at exactly the budget (budget 2, two conflicts) → STOCK_WRITE_CONFLICT', async () => {
      seedLevel(repository, 10);
      repository.conflictsBeforeSuccess = 2;

      const error = await applyOnHandChange(
        { ...deps, maxAttempts: 2 },
        { variantId: VARIANT_ID, stockLocationId: LOCATION, delta: 5 },
      ).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(InventoryDomainException);
      expect((error as InventoryDomainException).code).toBe(
        InventoryErrorCodeEnum.STOCK_WRITE_CONFLICT,
      );
      expect(transaction.calls).toBe(2);
      expect(cache.invalidations).toHaveLength(0);
    });
  });

  describe('the optional ledger movement leg (ADR-030 §2)', () => {
    it('appends the built movement inside the same transaction scope and returns it', async () => {
      seedLevel(repository, 10);

      const { level, movement } = await applyOnHandChange(deps, {
        variantId: VARIANT_ID,
        stockLocationId: LOCATION,
        delta: 5,
        buildMovement: (saved) =>
          StockMovement.record({
            variantId: saved.variantId,
            stockLocationId: saved.stockLocationId,
            type: StockMovementTypeEnum.RECEIPT,
            quantity: 5,
            actorId: 'staff-1',
          }),
      });

      expect(movements.appended).toHaveLength(1);
      expect(movement).not.toBeNull();
      expect(movement?.id).toBe(1);
      expect(movement?.type).toBe(StockMovementTypeEnum.RECEIPT);
      expect(movement?.quantity).toBe(5);
      expect(movement?.actorId).toBe('staff-1');
      expect(movements.appendScopes[0]).toBe(transaction.lastScope);
      expect(level.quantityOnHand).toBe(15);
    });

    it('writes NO movement when buildMovement is not supplied (bare counter callers unaffected)', async () => {
      seedLevel(repository, 10);

      const { movement } = await applyOnHandChange(deps, {
        variantId: VARIANT_ID,
        stockLocationId: LOCATION,
        delta: 5,
      });

      expect(movement).toBeNull();
      expect(movements.appended).toHaveLength(0);
    });

    it('appends the movement exactly once across an optimistic retry (after persist, not per attempt)', async () => {
      seedLevel(repository, 10);
      repository.conflictsBeforeSuccess = 2;

      await applyOnHandChange(deps, {
        variantId: VARIANT_ID,
        stockLocationId: LOCATION,
        delta: 5,
        buildMovement: (saved) =>
          StockMovement.record({
            variantId: saved.variantId,
            stockLocationId: saved.stockLocationId,
            type: StockMovementTypeEnum.RECEIPT,
            quantity: 5,
          }),
      });

      expect(transaction.calls).toBe(3);
      expect(movements.appended).toHaveLength(1);
    });

    it('appends NO movement when the counter write is rejected before persist', async () => {
      seedLevel(repository, 3);

      await expect(
        applyOnHandChange(deps, {
          variantId: VARIANT_ID,
          stockLocationId: LOCATION,
          delta: -5,
          buildMovement: (saved) =>
            StockMovement.record({
              variantId: saved.variantId,
              stockLocationId: saved.stockLocationId,
              type: StockMovementTypeEnum.ADJUSTMENT,
              quantity: -5,
              reasonCode: 'damaged',
            }),
        }),
      ).rejects.toMatchObject({ code: InventoryErrorCodeEnum.STOCK_RESULT_NEGATIVE });

      expect(movements.appended).toHaveLength(0);
    });
  });
});
