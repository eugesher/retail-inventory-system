import { PinoLogger } from 'nestjs-pino';

import {
  IOrderConfirm,
  OrderProductStatusEnum,
  OrderStatusEnum,
} from '@retail-inventory-system/contracts';

import { ConfirmOrderUseCase } from '../confirm-order.use-case';
import {
  buildPersistedOrder,
  InMemoryInventoryConfirmGateway,
  InMemoryOrderEventsPublisher,
  InMemoryOrderRepository,
} from './test-doubles';

type LoggerMock = Record<'debug' | 'info' | 'warn' | 'error' | 'fatal' | 'trace', jest.Mock>;

const makeLogger = (): LoggerMock => ({
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  fatal: jest.fn(),
  trace: jest.fn(),
});

describe('ConfirmOrderUseCase', () => {
  let repository: InMemoryOrderRepository;
  let inventory: InMemoryInventoryConfirmGateway;
  let publisher: InMemoryOrderEventsPublisher;
  let logger: LoggerMock;
  let useCase: ConfirmOrderUseCase;

  beforeEach(() => {
    repository = new InMemoryOrderRepository();
    inventory = new InMemoryInventoryConfirmGateway();
    publisher = new InMemoryOrderEventsPublisher();
    logger = makeLogger();
    useCase = new ConfirmOrderUseCase(
      repository,
      inventory,
      publisher,
      logger as unknown as PinoLogger,
    );
  });

  const buildPayload = (
    orderId: number,
    lineIds: number[],
    productIds: number[] = lineIds,
  ): IOrderConfirm => ({
    id: orderId,
    products: lineIds.map((id, i) => ({
      id,
      productId: productIds[i],
      statusId: OrderProductStatusEnum.PENDING,
    })),
    correlationId: 'corr-1',
  });

  it('confirms every line, flips the header to CONFIRMED, and publishes retail.order.confirmed (stock-confirmed branch)', async () => {
    const order = buildPersistedOrder({
      id: 7,
      lines: [
        { id: 71, productId: 1 },
        { id: 72, productId: 2 },
      ],
    });
    repository.seed(order);
    inventory.response = [71, 72];

    const response = await useCase.execute(buildPayload(7, [71, 72], [1, 2]));

    expect(response.id).toBe(7);
    expect(response.status.id).toBe(OrderStatusEnum.CONFIRMED);
    expect(response.products.every((p) => p.status.id === OrderProductStatusEnum.CONFIRMED)).toBe(
      true,
    );

    expect(repository.confirmLineCalls).toEqual([
      {
        orderId: 7,
        newlyConfirmedProductIds: [71, 72],
        shouldFlipHeaderToConfirmed: true,
        correlationId: 'corr-1',
      },
    ]);
    expect(publisher.confirmed).toHaveLength(1);
    const [{ event, correlationId }] = publisher.confirmed;
    expect(event.aggregateId).toBe(7);
    expect(event.lines).toEqual([
      { orderProductId: 71, productId: 1 },
      { orderProductId: 72, productId: 2 },
    ]);
    expect(correlationId).toBe('corr-1');
  });

  it('partially confirms when inventory returns a subset (stock-insufficient branch)', async () => {
    const order = buildPersistedOrder({
      id: 8,
      lines: [
        { id: 81, productId: 1 },
        { id: 82, productId: 2 },
      ],
    });
    repository.seed(order);
    inventory.response = [81]; // only line 81 reserved

    const response = await useCase.execute(buildPayload(8, [81, 82], [1, 2]));

    expect(response.status.id).toBe(OrderStatusEnum.PENDING);
    expect(repository.confirmLineCalls).toEqual([
      {
        orderId: 8,
        newlyConfirmedProductIds: [81],
        shouldFlipHeaderToConfirmed: false,
        correlationId: 'corr-1',
      },
    ]);
    expect(publisher.confirmed).toHaveLength(0);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ orderId: 8, confirmedCount: 1, totalCount: 2 }),
      'Order partially confirmed',
    );
  });

  it('skips the update and reads the snapshot when nothing was reservable', async () => {
    const order = buildPersistedOrder({
      id: 9,
      lines: [{ id: 91, productId: 1 }],
    });
    repository.seed(order);
    inventory.response = [];

    const response = await useCase.execute(buildPayload(9, [91], [1]));

    expect(response.status.id).toBe(OrderStatusEnum.PENDING);
    expect(repository.confirmLineCalls).toHaveLength(0);
    expect(publisher.confirmed).toHaveLength(0);
    expect(logger.debug).toHaveBeenCalledWith(
      expect.objectContaining({ orderId: 9 }),
      'No state update required',
    );
  });

  it('rethrows when the inventory RPC fails (timeout branch)', async () => {
    const order = buildPersistedOrder({ id: 10, lines: [{ id: 101, productId: 1 }] });
    repository.seed(order);
    inventory.shouldThrow = new Error('rmq-timeout');

    await expect(useCase.execute(buildPayload(10, [101], [1]))).rejects.toThrow('rmq-timeout');

    expect(repository.confirmLineCalls).toHaveLength(0);
    expect(publisher.confirmed).toHaveLength(0);
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ orderId: 10 }),
      'Inventory order.confirm RPC failed',
    );
  });

  it('throws when the order disappears between the inventory RPC and the aggregate fetch', async () => {
    inventory.response = [];

    await expect(useCase.execute(buildPayload(404, [4041], [1]))).rejects.toThrow(
      'Order #404 not found after inventory confirmation',
    );
  });

  it('warn-logs and continues when publishOrderConfirmed rejects (publish is best-effort post-commit)', async () => {
    const order = buildPersistedOrder({ id: 11, lines: [{ id: 111, productId: 1 }] });
    repository.seed(order);
    inventory.response = [111];
    publisher.publishOrderConfirmed = (): Promise<void> => Promise.reject(new Error('rmq-down'));

    const response = await useCase.execute(buildPayload(11, [111], [1]));

    expect(response.status.id).toBe(OrderStatusEnum.CONFIRMED);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ orderId: 11 }),
      'Failed to publish retail.order.confirmed event',
    );
  });
});
