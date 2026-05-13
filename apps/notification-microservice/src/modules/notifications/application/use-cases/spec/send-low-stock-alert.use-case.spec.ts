import { PinoLogger } from 'nestjs-pino';

import { IInventoryStockLowEvent } from '@retail-inventory-system/contracts';

import { NotificationChannelEnum } from '../../../domain';
import { SendLowStockAlertUseCase } from '../send-low-stock-alert.use-case';
import { FakeLogger, InMemoryNotifier } from './test-doubles';

describe('SendLowStockAlertUseCase', () => {
  let notifier: InMemoryNotifier;
  let logger: FakeLogger;
  let useCase: SendLowStockAlertUseCase;

  beforeEach(() => {
    notifier = new InMemoryNotifier();
    logger = new FakeLogger();
    useCase = new SendLowStockAlertUseCase(notifier, logger as unknown as PinoLogger);
  });

  const buildEvent = (
    overrides: Partial<IInventoryStockLowEvent> = {},
  ): IInventoryStockLowEvent => ({
    correlationId: 'corr-2',
    productId: 11,
    storageId: 'head-warehouse',
    quantity: 1,
    threshold: 5,
    occurredAt: '2026-05-13T12:35:00.000Z',
    ...overrides,
  });

  it('dispatches a low-stock notification with product and threshold details', async () => {
    await useCase.execute(buildEvent());

    expect(notifier.sent).toHaveLength(1);
    const sent = notifier.sent[0];

    expect(sent.recipient).toBe('ops:inventory');
    expect(sent.channel).toBe(NotificationChannelEnum.LOG);
    expect(sent.subject).toContain('product 11');
    expect(sent.subject).toContain('head-warehouse');
    expect(sent.body).toContain('1 units');
    expect(sent.body).toContain('threshold 5');
    expect(sent.metadata).toEqual({
      productId: 11,
      storageId: 'head-warehouse',
      quantity: 1,
      threshold: 5,
      occurredAt: '2026-05-13T12:35:00.000Z',
    });
  });

  it('logs the correlationId on the dispatch line', async () => {
    await useCase.execute(buildEvent({ correlationId: 'corr-low' }));

    expect(logger.logs[0].context).toMatchObject({ correlationId: 'corr-low' });
  });
});
