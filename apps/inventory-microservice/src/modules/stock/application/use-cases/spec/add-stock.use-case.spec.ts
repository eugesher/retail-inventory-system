import { PinoLogger } from 'nestjs-pino';
import { EntityManager } from 'typeorm';

import { makePinoLoggerMock, PinoLoggerMock } from '@retail-inventory-system/observability/testing';

import { IStockAppendDeltaItem, IStockRepositoryPort } from '../../ports';
import { AddStockUseCase } from '../add-stock.use-case';

const correlationId = 'corr-1';
const items: IStockAppendDeltaItem[] = [
  {
    productId: 1,
    storageId: 'head-warehouse',
    actionId: 'order-product-confirm',
    quantity: -1,
    orderProductId: 11,
  },
  {
    productId: 2,
    storageId: 'head-warehouse',
    actionId: 'order-product-confirm',
    quantity: -1,
    orderProductId: 12,
  },
];

describe('AddStockUseCase', () => {
  let repository: jest.Mocked<Pick<IStockRepositoryPort, 'appendDeltas'>>;
  let logger: PinoLoggerMock;
  let useCase: AddStockUseCase;

  beforeEach(() => {
    jest.resetAllMocks();
    repository = { appendDeltas: jest.fn() } as never;
    logger = makePinoLoggerMock();
    useCase = new AddStockUseCase(
      repository as unknown as IStockRepositoryPort,
      logger as unknown as PinoLogger,
    );
  });

  describe('execute', () => {
    it('delegates to the repository without an entity manager and debug-logs withinTransaction:false', async () => {
      repository.appendDeltas.mockResolvedValue(undefined);

      await useCase.execute({ items, correlationId });

      expect(repository.appendDeltas).toHaveBeenCalledWith({ items, correlationId }, undefined);
      expect(logger.debug).toHaveBeenCalledWith(
        { correlationId, itemCount: 2, withinTransaction: false },
        'Delegating to stock repository for ledger append',
      );
    });

    it('passes the entity manager through and debug-logs withinTransaction:true', async () => {
      const em = {} as EntityManager;
      repository.appendDeltas.mockResolvedValue(undefined);

      await useCase.execute({ items, correlationId }, em);

      expect(repository.appendDeltas).toHaveBeenCalledWith({ items, correlationId }, em);
      expect(logger.debug).toHaveBeenCalledWith(
        { correlationId, itemCount: 2, withinTransaction: true },
        'Delegating to stock repository for ledger append',
      );
    });
  });
});
