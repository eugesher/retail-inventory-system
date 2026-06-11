import { PinoLogger } from 'nestjs-pino';

import { IRetailOrderPlacedEvent } from '@retail-inventory-system/contracts';

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
    overrides: Partial<IRetailOrderPlacedEvent> = {},
  ): IRetailOrderPlacedEvent => ({
    correlationId: 'corr-order-1',
    orderId: 4242,
    orderNumber: 'ORD-2026-00004242',
    customerId: '11111111-1111-4111-8111-111111111111',
    grandTotalMinor: 29997,
    currency: 'USD',
    lineCount: 2,
    eventVersion: 'v1',
    occurredAt: '2026-06-10T12:00:00.000Z',
    ...overrides,
  });

  it('dispatches an order-placed notification carrying the order number, id, and totals', async () => {
    await useCase.execute(buildEvent());

    expect(notifier.sent).toHaveLength(1);
    const sent = notifier.sent[0];

    expect(sent.recipient).toBe('order:4242');
    expect(sent.channel).toBe(NotificationChannelEnum.LOG);
    expect(sent.subject).toContain('ORD-2026-00004242');
    expect(sent.body).toContain('ORD-2026-00004242');
    expect(sent.body).toContain('29997');
    expect(sent.body).toContain('USD');
    expect(sent.body).toContain('2 lines');
    expect(sent.metadata).toEqual({
      orderId: 4242,
      orderNumber: 'ORD-2026-00004242',
      customerId: '11111111-1111-4111-8111-111111111111',
      grandTotalMinor: 29997,
      currency: 'USD',
      lineCount: 2,
      occurredAt: '2026-06-10T12:00:00.000Z',
    });
  });

  it('singularizes the line word for a one-line order', async () => {
    await useCase.execute(buildEvent({ lineCount: 1 }));

    expect(notifier.sent[0].body).toContain('1 line');
    expect(notifier.sent[0].body).not.toContain('1 lines');
  });

  it('carries a null customerId straight through to the metadata (a tombstoned order)', async () => {
    await useCase.execute(buildEvent({ customerId: null }));

    expect(notifier.sent[0].metadata).toMatchObject({ customerId: null });
  });

  it('logs the correlationId on the dispatch line', async () => {
    await useCase.execute(buildEvent({ correlationId: 'corr-order-9' }));

    expect(logger.logs[0].context).toMatchObject({ correlationId: 'corr-order-9' });
  });
});
