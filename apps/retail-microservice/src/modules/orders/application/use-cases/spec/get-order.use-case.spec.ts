import { PinoLogger } from 'nestjs-pino';

import { OrderStatusEnum } from '@retail-inventory-system/contracts';

import { GetOrderUseCase } from '../get-order.use-case';
import { buildPersistedOrder, InMemoryOrderRepository } from './test-doubles';

type LoggerMock = Record<'debug' | 'info' | 'warn' | 'error' | 'fatal' | 'trace', jest.Mock>;

const makeLogger = (): LoggerMock => ({
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  fatal: jest.fn(),
  trace: jest.fn(),
});

describe('GetOrderUseCase', () => {
  let repository: InMemoryOrderRepository;
  let logger: LoggerMock;
  let useCase: GetOrderUseCase;

  beforeEach(() => {
    repository = new InMemoryOrderRepository();
    logger = makeLogger();
    useCase = new GetOrderUseCase(repository, logger as unknown as PinoLogger);
  });

  it('returns just the header status when the order exists', async () => {
    repository.seed(buildPersistedOrder({ id: 1, lines: [{ id: 11, productId: 1 }] }));

    const header = await useCase.findHeaderById(1);

    expect(header).toEqual({ statusId: OrderStatusEnum.PENDING });
  });

  it('returns null when the order is missing', async () => {
    const header = await useCase.findHeaderById(404);

    expect(header).toBeNull();
  });
});
