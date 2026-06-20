import { PinoLogger } from 'nestjs-pino';

import {
  IRetailRefundIssuedEvent,
  NotificationChannelEnum,
} from '@retail-inventory-system/contracts';

import { SendRefundNotificationUseCase } from '../send-refund-notification.use-case';
import { FakeLogger, InMemoryNotifier } from './test-doubles';

describe('SendRefundNotificationUseCase', () => {
  let notifier: InMemoryNotifier;
  let logger: FakeLogger;
  let useCase: SendRefundNotificationUseCase;

  beforeEach(() => {
    notifier = new InMemoryNotifier();
    logger = new FakeLogger();
    useCase = new SendRefundNotificationUseCase(notifier, logger as unknown as PinoLogger);
  });

  const buildIssued = (
    overrides: Partial<IRetailRefundIssuedEvent> = {},
  ): IRetailRefundIssuedEvent => ({
    correlationId: 'corr-refund-1',
    refundId: 12,
    orderId: 4242,
    paymentId: 88,
    amountMinor: 1500,
    currency: 'USD',
    issuedAt: '2026-06-19T16:00:00.000Z',
    eventVersion: 'v1',
    occurredAt: '2026-06-19T16:00:01.000Z',
    ...overrides,
  });

  describe('issued', () => {
    it('dispatches a refund-issued notification carrying the refund, order, payment, and amount', async () => {
      await useCase.issued(buildIssued());

      expect(notifier.sent).toHaveLength(1);
      const sent = notifier.sent[0];

      expect(sent.recipient).toBe('order:4242');
      expect(sent.channel).toBe(NotificationChannelEnum.EMAIL);
      expect(sent.subject).toContain('Refund');
      expect(sent.subject).toContain('4242');
      expect(sent.body).toContain('12');
      expect(sent.body).toContain('1500');
      expect(sent.body).toContain('USD');
      expect(sent.body).toContain('88');
      expect(sent.metadata).toEqual({
        refundId: 12,
        orderId: 4242,
        paymentId: 88,
        amountMinor: 1500,
        currency: 'USD',
        issuedAt: '2026-06-19T16:00:00.000Z',
        occurredAt: '2026-06-19T16:00:01.000Z',
      });
    });

    it('logs the correlationId on the dispatch line', async () => {
      await useCase.issued(buildIssued({ correlationId: 'corr-refund-9' }));

      expect(logger.logs[0].context).toMatchObject({ correlationId: 'corr-refund-9' });
    });
  });
});
