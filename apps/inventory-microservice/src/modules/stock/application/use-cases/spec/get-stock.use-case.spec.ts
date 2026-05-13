import { PinoLogger } from 'nestjs-pino';
import { EntityManager } from 'typeorm';

import { ProductStockGetResponseDto } from '@retail-inventory-system/contracts';

import { IStockCachePort, IStockRepositoryPort } from '../../ports';
import { GetStockUseCase } from '../get-stock.use-case';

type LoggerMock = Record<'debug' | 'info' | 'warn' | 'error' | 'fatal' | 'trace', jest.Mock>;

const makeLogger = (): LoggerMock => ({
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  fatal: jest.fn(),
  trace: jest.fn(),
});

const correlationId = 'corr-1';
const sampleDto: ProductStockGetResponseDto = {
  productId: 1,
  quantity: 5,
  updatedAt: null,
  items: [],
};

describe('GetStockUseCase', () => {
  let repository: jest.Mocked<Pick<IStockRepositoryPort, 'aggregateForProduct'>>;
  let stockCache: jest.Mocked<Pick<IStockCachePort, 'get' | 'set'>>;
  let logger: LoggerMock;
  let useCase: GetStockUseCase;

  beforeEach(() => {
    jest.resetAllMocks();
    repository = { aggregateForProduct: jest.fn() } as never;
    stockCache = { get: jest.fn(), set: jest.fn() } as never;
    logger = makeLogger();
    useCase = new GetStockUseCase(
      repository as unknown as IStockRepositoryPort,
      stockCache as unknown as IStockCachePort,
      logger as unknown as PinoLogger,
    );
  });

  describe('execute', () => {
    it('info-logs the RPC entry and returns cached DTO on cache hit', async () => {
      stockCache.get.mockResolvedValue(sampleDto);

      const payload = { productId: 1, correlationId };
      const result = await useCase.execute(payload);

      expect(result).toBe(sampleDto);
      expect(stockCache.get).toHaveBeenCalledWith({
        productId: 1,
        storageIds: undefined,
        correlationId,
      });
      expect(repository.aggregateForProduct).not.toHaveBeenCalled();
      expect(stockCache.set).not.toHaveBeenCalled();
      expect(logger.info).toHaveBeenCalledWith(payload, 'Received RPC: get product stock');
    });

    it('falls through to the repository on cache miss and writes the result back', async () => {
      stockCache.get.mockResolvedValue(undefined);
      repository.aggregateForProduct.mockResolvedValue(sampleDto);

      const result = await useCase.execute({ productId: 1, correlationId });

      expect(result).toBe(sampleDto);
      expect(repository.aggregateForProduct).toHaveBeenCalledWith({
        productId: 1,
        storageIds: undefined,
        correlationId,
      });
      expect(stockCache.set).toHaveBeenCalledWith({
        productId: 1,
        storageIds: undefined,
        data: sampleDto,
        correlationId,
      });
    });

    it('error-logs and rethrows when the repository rejects on cache miss', async () => {
      const err = new Error('db-fail');
      stockCache.get.mockResolvedValue(undefined);
      repository.aggregateForProduct.mockRejectedValue(err);

      await expect(useCase.execute({ productId: 1, correlationId })).rejects.toBe(err);

      expect(stockCache.set).not.toHaveBeenCalled();
      expect(logger.error).toHaveBeenCalledWith(
        { err, productId: 1, correlationId },
        'Error retrieving product stock',
      );
    });

    it('skips both cache read and write when an entity manager is provided', async () => {
      const em = {} as EntityManager;
      repository.aggregateForProduct.mockResolvedValue(sampleDto);

      await useCase.execute({ productId: 1, correlationId }, { entityManager: em });

      expect(stockCache.get).not.toHaveBeenCalled();
      expect(stockCache.set).not.toHaveBeenCalled();
      expect(repository.aggregateForProduct).toHaveBeenCalledWith(
        { productId: 1, storageIds: undefined, correlationId },
        em,
      );
      expect(logger.debug).toHaveBeenCalledWith(
        { correlationId, productId: 1, reason: 'entityManager' },
        'Cache skipped for stock query',
      );
    });

    it('skips both cache read and write when ignoreCache is true', async () => {
      repository.aggregateForProduct.mockResolvedValue(sampleDto);

      await useCase.execute({ productId: 1, correlationId }, { ignoreCache: true });

      expect(stockCache.get).not.toHaveBeenCalled();
      expect(stockCache.set).not.toHaveBeenCalled();
      expect(logger.debug).toHaveBeenCalledWith(
        { correlationId, productId: 1, reason: 'ignoreCache' },
        'Cache skipped for stock query',
      );
    });

    it('prefers reason:entityManager when both options are set', async () => {
      const em = {} as EntityManager;
      repository.aggregateForProduct.mockResolvedValue(sampleDto);

      await useCase.execute(
        { productId: 1, correlationId },
        { entityManager: em, ignoreCache: true },
      );

      expect(logger.debug).toHaveBeenCalledWith(
        { correlationId, productId: 1, reason: 'entityManager' },
        'Cache skipped for stock query',
      );
    });

    it('orders cache.get → repository.aggregateForProduct → cache.set on the miss path', async () => {
      stockCache.get.mockResolvedValue(undefined);
      repository.aggregateForProduct.mockResolvedValue(sampleDto);
      stockCache.set.mockResolvedValue(undefined);

      await useCase.execute({ productId: 1, correlationId });

      const getOrder = stockCache.get.mock.invocationCallOrder[0];
      const dbOrder = repository.aggregateForProduct.mock.invocationCallOrder[0];
      const setOrder = stockCache.set.mock.invocationCallOrder[0];
      expect(getOrder).toBeLessThan(dbOrder);
      expect(dbOrder).toBeLessThan(setOrder);
    });
  });
});
