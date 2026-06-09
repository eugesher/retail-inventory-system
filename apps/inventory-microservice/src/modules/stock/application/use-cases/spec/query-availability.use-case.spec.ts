import { PinoLogger } from 'nestjs-pino';

import { VariantStockView } from '@retail-inventory-system/contracts';
import { makePinoLoggerMock, PinoLoggerMock } from '@retail-inventory-system/observability/testing';

import { StockLevel } from '../../../domain';
import { QueryAvailabilityUseCase } from '../query-availability.use-case';
import { InMemoryStockCache, InMemoryStockRepository } from './test-doubles';

const correlationId = 'corr-1';

const level = (props: {
  variantId: number;
  stockLocationId: string;
  quantityOnHand: number;
  quantityAllocated?: number;
  quantityReserved?: number;
  version?: number;
  updatedAt?: Date | null;
}): StockLevel =>
  new StockLevel({
    variantId: props.variantId,
    stockLocationId: props.stockLocationId,
    quantityOnHand: props.quantityOnHand,
    quantityAllocated: props.quantityAllocated ?? 0,
    quantityReserved: props.quantityReserved ?? 0,
    version: props.version ?? 0,
    updatedAt: props.updatedAt ?? null,
  });

describe('QueryAvailabilityUseCase', () => {
  let repository: InMemoryStockRepository;
  let cache: InMemoryStockCache;
  let logger: PinoLoggerMock;
  let useCase: QueryAvailabilityUseCase;

  beforeEach(() => {
    repository = new InMemoryStockRepository();
    cache = new InMemoryStockCache();
    logger = makePinoLoggerMock();
    useCase = new QueryAvailabilityUseCase(repository, cache, logger as unknown as PinoLogger);
  });

  it('returns the cached VariantStockView on a hit without touching the repository', async () => {
    const cached: VariantStockView = {
      variantId: 42,
      totalOnHand: 99,
      totalAvailable: 88,
      locations: [],
    };
    cache.seed(42, cached);
    const repoSpy = jest.spyOn(repository, 'findStockLevelsByVariant');

    const result = await useCase.execute({ variantId: 42, correlationId });

    expect(result).toBe(cached);
    expect(repoSpy).not.toHaveBeenCalled();
  });

  it('loads from the repository on a miss and writes the value back via getOrLoad', async () => {
    repository.seedLevel(
      level({ variantId: 42, stockLocationId: 'default-warehouse', quantityOnHand: 7 }),
    );

    const result = await useCase.execute({ variantId: 42, correlationId });

    // Repository projection surfaced.
    expect(result.variantId).toBe(42);
    expect(result.locations).toHaveLength(1);
    expect(result.locations[0].stockLocationId).toBe('default-warehouse');
    // Write-back happened through getOrLoad.
    expect(cache.setCalls).toHaveLength(1);
    expect(cache.setCalls[0].data).toBe(result);
  });

  it('computes per-location available and aggregates the totals, sorted by stockLocationId', async () => {
    // west sorts after default by localeCompare; seed out of order to prove the sort.
    repository.seedLevel(
      level({
        variantId: 42,
        stockLocationId: 'west-warehouse',
        quantityOnHand: 5,
      }),
    );
    repository.seedLevel(
      level({
        variantId: 42,
        stockLocationId: 'default-warehouse',
        quantityOnHand: 10,
        quantityAllocated: 2,
        quantityReserved: 1,
      }),
    );

    const result = await useCase.execute({ variantId: 42, correlationId });

    expect(result.locations.map((l) => l.stockLocationId)).toEqual([
      'default-warehouse',
      'west-warehouse',
    ]);
    // default: 10 − 2 − 1 = 7; west: 5 − 0 − 0 = 5.
    expect(result.locations[0].available).toBe(7);
    expect(result.locations[1].available).toBe(5);
    // Totals are the cross-location sums.
    expect(result.totalOnHand).toBe(15);
    expect(result.totalAvailable).toBe(12);
  });

  it('caches an empty result (no rows) as a valid zero-totals value', async () => {
    const result = await useCase.execute({ variantId: 999, correlationId });

    expect(result).toEqual({
      variantId: 999,
      totalOnHand: 0,
      totalAvailable: 0,
      locations: [],
    });
    // The empty projection is written back — it is a valid cached value, not a
    // "skip the cache" signal.
    expect(cache.setCalls).toHaveLength(1);
    expect(cache.setCalls[0].data).toEqual(result);
  });

  it('honours the stockLocationIds scope by passing it to the repository', async () => {
    repository.seedLevel(
      level({ variantId: 42, stockLocationId: 'default-warehouse', quantityOnHand: 10 }),
    );
    repository.seedLevel(
      level({ variantId: 42, stockLocationId: 'west-warehouse', quantityOnHand: 5 }),
    );

    const result = await useCase.execute({
      variantId: 42,
      stockLocationIds: ['west-warehouse'],
      correlationId,
    });

    expect(result.locations).toHaveLength(1);
    expect(result.locations[0].stockLocationId).toBe('west-warehouse');
    expect(result.totalOnHand).toBe(5);
  });

  it('falls back to the repository on a Redis-down read without a write-back', async () => {
    // CACHE-005: a read that returns `available: false` short-circuits the
    // write-back so the request is served from the DB without re-attempting a
    // dead cache (the duplicate-warn suppression itself is covered at the
    // StockCache adapter level).
    cache.available = false;
    repository.seedLevel(
      level({ variantId: 42, stockLocationId: 'default-warehouse', quantityOnHand: 7 }),
    );

    const result = await useCase.execute({ variantId: 42, correlationId });

    expect(result.totalOnHand).toBe(7);
    expect(cache.setCalls).toHaveLength(0);
  });

  it('logs and rethrows when the repository load fails', async () => {
    const err = new Error('db-down');
    jest.spyOn(repository, 'findStockLevelsByVariant').mockRejectedValueOnce(err);

    await expect(useCase.execute({ variantId: 42, correlationId })).rejects.toBe(err);
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ err }),
      'Error querying variant availability',
    );
  });
});
