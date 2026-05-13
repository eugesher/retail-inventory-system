import { PinoLogger } from 'nestjs-pino';

import { IRetailOrderCreatedEvent, OrderStatusEnum } from '@retail-inventory-system/contracts';

import { NotificationChannelEnum } from '../../../domain';
import { SendOrderNotificationUseCase } from '../send-order-notification.use-case';
import { FakeLogger, InMemoryNotifier } from './test-doubles';

describe('SendOrderNotificationUseCase', () => {
  let notifier: InMemoryNotifier;
  let logger: FakeLogger;
  let useCase: SendOrderNotificationUseCase;

  beforeEach(() => {
    notifier = new InMemoryNotifier();
    logger = new FakeLogger();
    useCase = new SendOrderNotificationUseCase(notifier, logger as unknown as PinoLogger);
  });

  const buildEvent = (
    overrides: Partial<IRetailOrderCreatedEvent> = {},
  ): IRetailOrderCreatedEvent => ({
    correlationId: 'corr-1',
    orderId: 42,
    customerId: 7,
    status: OrderStatusEnum.PENDING,
    products: [{ productId: 1, quantity: 2 }],
    occurredAt: '2026-05-13T12:34:56.000Z',
    ...overrides,
  });

  it('dispatches a notification with the order details', async () => {
    await useCase.execute(buildEvent());

    expect(notifier.sent).toHaveLength(1);
    const sent = notifier.sent[0];

    expect(sent.recipient).toBe('customer:7');
    expect(sent.channel).toBe(NotificationChannelEnum.LOG);
    expect(sent.subject).toBe('Order 42 received');
    expect(sent.body).toContain('Order 42');
    expect(sent.body).toContain('customer 7');
    expect(sent.body).toContain('pending');
    expect(sent.metadata).toEqual({
      orderId: 42,
      customerId: 7,
      status: OrderStatusEnum.PENDING,
      productCount: 1,
      occurredAt: '2026-05-13T12:34:56.000Z',
    });
  });

  it('logs the correlationId on the dispatch line', async () => {
    await useCase.execute(buildEvent({ correlationId: 'corr-xyz' }));

    expect(logger.logs[0].context).toMatchObject({ correlationId: 'corr-xyz' });
  });

  it('counts every product line into the metadata', async () => {
    await useCase.execute(
      buildEvent({
        products: [
          { productId: 1, quantity: 2 },
          { productId: 5, quantity: 1 },
          { productId: 9, quantity: 3 },
        ],
      }),
    );

    expect(notifier.sent[0].metadata.productCount).toBe(3);
  });
});
