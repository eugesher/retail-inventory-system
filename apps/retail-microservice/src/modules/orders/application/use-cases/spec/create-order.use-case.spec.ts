import { PinoLogger } from 'nestjs-pino';

import {
  IOrderCreatePayload,
  OrderProductStatusEnum,
  OrderStatusEnum,
} from '@retail-inventory-system/contracts';

import { CreateOrderUseCase } from '../create-order.use-case';
import { InMemoryOrderEventsPublisher, InMemoryOrderRepository } from './test-doubles';

type LoggerMock = Record<'debug' | 'info' | 'warn' | 'error' | 'fatal' | 'trace', jest.Mock>;

const makeLogger = (): LoggerMock => ({
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  fatal: jest.fn(),
  trace: jest.fn(),
});

describe('CreateOrderUseCase', () => {
  let repository: InMemoryOrderRepository;
  let publisher: InMemoryOrderEventsPublisher;
  let logger: LoggerMock;
  let useCase: CreateOrderUseCase;

  beforeEach(() => {
    repository = new InMemoryOrderRepository();
    publisher = new InMemoryOrderEventsPublisher();
    logger = makeLogger();
    useCase = new CreateOrderUseCase(repository, publisher, logger as unknown as PinoLogger);
  });

  const payload: IOrderCreatePayload = {
    customerId: 1,
    products: [
      { productId: 1, quantity: 2 },
      { productId: 2, quantity: 1 },
    ],
    correlationId: 'corr-1',
  };

  it('persists the order, returns the response DTO, and publishes retail.order.created', async () => {
    const response = await useCase.execute(payload);

    expect(response.orderId).toEqual(expect.any(Number));
    expect(response.status).toBe(OrderStatusEnum.PENDING);
    expect(response.message).toBe('Order successfully created');

    expect(repository.savedAggregates).toHaveLength(1);
    const saved = repository.savedAggregates[0];
    // Per-unit expansion: 2 + 1 = 3 line items.
    expect(saved.products).toHaveLength(3);
    expect(saved.products.every((p) => p.statusId === OrderProductStatusEnum.PENDING)).toBe(true);

    expect(publisher.created).toHaveLength(1);
    const [{ event, correlationId }] = publisher.created;
    expect(event.aggregateId).toBe(response.orderId);
    expect(event.customerId).toBe(1);
    expect(event.lines).toEqual([
      { productId: 1, quantity: 2 },
      { productId: 2, quantity: 1 },
    ]);
    expect(correlationId).toBe('corr-1');
  });

  it('still returns the response when the publisher rejects (publish is best-effort post-save)', async () => {
    publisher.publishOrderCreated = (): Promise<void> => Promise.reject(new Error('rmq-down'));

    const response = await useCase.execute(payload);

    expect(response.orderId).toEqual(expect.any(Number));
    expect(repository.savedAggregates).toHaveLength(1);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ correlationId: 'corr-1' }),
      'Failed to publish retail.order.created event',
    );
  });

  it('rethrows when the repository rejects', async () => {
    const err = new Error('db-down');
    repository.save = (): Promise<never> => Promise.reject(err);

    await expect(useCase.execute(payload)).rejects.toBe(err);
    expect(publisher.created).toHaveLength(0);
  });
});
