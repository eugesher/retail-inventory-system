import { PinoLogger } from 'nestjs-pino';

import { ProductStockGetResponseDto } from '@retail-inventory-system/contracts';
import { makePinoLoggerMock, PinoLoggerMock } from '@retail-inventory-system/observability/testing';

import { IStockCachePort, IStockRepositoryPort, ITransactionScope } from '../../ports';
import { GetStockUseCase } from '../get-stock.use-case';

const correlationId = 'corr-1';
const sampleDto: ProductStockGetResponseDto = {
  productId: 1,
  quantity: 5,
  updatedAt: null,
  items: [],
};

describe('GetStockUseCase', () => {
  let repository: jest.Mocked<Pick<IStockRepositoryPort, 'aggregateForProduct'>>;
  // Cache-aside lives entirely in `getOrLoad` (ADR-021 single-flight +
  // jitter); the use case never calls `get`/`set` on the cache-using path.
  let stockCache: jest.Mocked<Pick<IStockCachePort, 'getOrLoad'>>;
  let logger: PinoLoggerMock;
  let useCase: GetStockUseCase;

  beforeEach(() => {
    jest.resetAllMocks();
    repository = { aggregateForProduct: jest.fn() } as never;
    stockCache = { getOrLoad: jest.fn() } as never;
    logger = makePinoLoggerMock();
    useCase = new GetStockUseCase(
      repository as unknown as IStockRepositoryPort,
      stockCache as unknown as IStockCachePort,
      logger as unknown as PinoLogger,
    );
  });

  describe('execute', () => {
    it('info-logs the RPC entry and returns the value resolved by getOrLoad', async () => {
      stockCache.getOrLoad.mockResolvedValue(sampleDto);

      const payload = { productId: 1, correlationId };
      const result = await useCase.execute(payload);

      expect(result).toBe(sampleDto);
      expect(stockCache.getOrLoad).toHaveBeenCalledWith(
        { productId: 1, storageIds: undefined, correlationId },
        expect.any(Function),
      );
      expect(logger.info).toHaveBeenCalledWith(payload, 'Received RPC: get product stock');
    });

    it('invokes the repository through the loader passed to getOrLoad', async () => {
      // The loader closure carries the repository call. Capture it from the
      // mocked port and execute it to assert the wiring is right.
      stockCache.getOrLoad.mockImplementation(async (_payload, loader) => loader());
      repository.aggregateForProduct.mockResolvedValue(sampleDto);

      const result = await useCase.execute({ productId: 1, correlationId });

      expect(result).toBe(sampleDto);
      expect(repository.aggregateForProduct).toHaveBeenCalledWith({
        productId: 1,
        storageIds: undefined,
        correlationId,
      });
    });

    it('error-logs and rethrows when getOrLoad rejects (loader failure)', async () => {
      const err = new Error('db-fail');
      stockCache.getOrLoad.mockRejectedValue(err);

      await expect(useCase.execute({ productId: 1, correlationId })).rejects.toBe(err);

      expect(logger.error).toHaveBeenCalledWith(
        { err, productId: 1, correlationId },
        'Error retrieving product stock',
      );
    });

    it('skips the cache entirely when a transaction scope is provided', async () => {
      const scope = {} as ITransactionScope;
      repository.aggregateForProduct.mockResolvedValue(sampleDto);

      await useCase.execute({ productId: 1, correlationId }, { scope });

      expect(stockCache.getOrLoad).not.toHaveBeenCalled();
      expect(repository.aggregateForProduct).toHaveBeenCalledWith(
        { productId: 1, storageIds: undefined, correlationId },
        scope,
      );
      expect(logger.debug).toHaveBeenCalledWith(
        { correlationId, productId: 1, reason: 'transactionScope' },
        'Cache skipped for stock query',
      );
    });

    it('skips the cache entirely when ignoreCache is true', async () => {
      repository.aggregateForProduct.mockResolvedValue(sampleDto);

      await useCase.execute({ productId: 1, correlationId }, { ignoreCache: true });

      expect(stockCache.getOrLoad).not.toHaveBeenCalled();
      expect(repository.aggregateForProduct).toHaveBeenCalledWith(
        { productId: 1, storageIds: undefined, correlationId },
        // Skip-cache branch forwards `scope` positionally; when only
        // `ignoreCache` is set the second arg is `undefined`.
        undefined,
      );
      expect(logger.debug).toHaveBeenCalledWith(
        { correlationId, productId: 1, reason: 'ignoreCache' },
        'Cache skipped for stock query',
      );
    });

    it('prefers reason:transactionScope when both options are set', async () => {
      const scope = {} as ITransactionScope;
      repository.aggregateForProduct.mockResolvedValue(sampleDto);

      await useCase.execute({ productId: 1, correlationId }, { scope, ignoreCache: true });

      expect(logger.debug).toHaveBeenCalledWith(
        { correlationId, productId: 1, reason: 'transactionScope' },
        'Cache skipped for stock query',
      );
    });

    it('fans out ≥10 concurrent miss-path executes to exactly one repository call', async () => {
      // ADR-021 acceptance criterion. Drives execute() N times concurrently
      // against a hand-rolled single-flight cache: the first caller starts
      // the loader; the rest join the in-flight promise. The contract is
      // "exactly one repository call regardless of concurrency".
      const inFlight = new Map<string, Promise<ProductStockGetResponseDto>>();

      stockCache.getOrLoad.mockImplementation(async (payload, loader) => {
        const key = `${payload.productId}:${(payload.storageIds ?? []).join(',')}`;
        const existing = inFlight.get(key);
        if (existing) return existing;
        const promise = (async (): Promise<ProductStockGetResponseDto> => loader())().finally(() =>
          inFlight.delete(key),
        );
        inFlight.set(key, promise);
        return promise;
      });

      let resolveLoader!: (v: ProductStockGetResponseDto) => void;
      repository.aggregateForProduct.mockImplementation(
        () =>
          new Promise<ProductStockGetResponseDto>((resolve) => {
            resolveLoader = resolve;
          }),
      );

      const callers = Array.from({ length: 15 }, () =>
        useCase.execute({ productId: 1, correlationId }),
      );
      // Yield so every caller attaches to the leader before it resolves.
      await Promise.resolve();
      resolveLoader(sampleDto);

      const results = await Promise.all(callers);

      expect(repository.aggregateForProduct).toHaveBeenCalledTimes(1);
      expect(results).toEqual(Array(15).fill(sampleDto));
    });
  });
});
