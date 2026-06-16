import { PinoLogger } from 'nestjs-pino';

import {
  IRetailFulfillmentDeliveredEvent,
  IRetailFulfillmentShippedEvent,
} from '@retail-inventory-system/contracts';

import { NotificationChannelEnum } from '../../../domain';
import { SendShipmentNotificationUseCase } from '../send-shipment-notification.use-case';
import { FakeLogger, InMemoryNotifier } from './test-doubles';

describe('SendShipmentNotificationUseCase', () => {
  let notifier: InMemoryNotifier;
  let logger: FakeLogger;
  let useCase: SendShipmentNotificationUseCase;

  beforeEach(() => {
    notifier = new InMemoryNotifier();
    logger = new FakeLogger();
    useCase = new SendShipmentNotificationUseCase(notifier, logger as unknown as PinoLogger);
  });

  const buildShipped = (
    overrides: Partial<IRetailFulfillmentShippedEvent> = {},
  ): IRetailFulfillmentShippedEvent => ({
    correlationId: 'corr-ship-1',
    orderId: 4242,
    fulfillmentId: 77,
    trackingNumber: '1Z-TRACK-001',
    carrier: 'UPS',
    shippedAt: '2026-06-12T09:00:00.000Z',
    eventVersion: 'v1',
    occurredAt: '2026-06-12T09:00:01.000Z',
    ...overrides,
  });

  const buildDelivered = (
    overrides: Partial<IRetailFulfillmentDeliveredEvent> = {},
  ): IRetailFulfillmentDeliveredEvent => ({
    correlationId: 'corr-deliver-1',
    orderId: 4242,
    fulfillmentId: 77,
    deliveredAt: '2026-06-14T15:30:00.000Z',
    eventVersion: 'v1',
    occurredAt: '2026-06-14T15:30:01.000Z',
    ...overrides,
  });

  describe('shipped', () => {
    it('dispatches a shipment-shipped notification carrying the order, fulfillment, tracking, and carrier', async () => {
      await useCase.shipped(buildShipped());

      expect(notifier.sent).toHaveLength(1);
      const sent = notifier.sent[0];

      expect(sent.recipient).toBe('order:4242');
      expect(sent.channel).toBe(NotificationChannelEnum.LOG);
      expect(sent.subject).toContain('4242');
      expect(sent.body).toContain('77');
      expect(sent.body).toContain('4242');
      expect(sent.body).toContain('UPS');
      expect(sent.body).toContain('1Z-TRACK-001');
      expect(sent.metadata).toEqual({
        orderId: 4242,
        fulfillmentId: 77,
        trackingNumber: '1Z-TRACK-001',
        carrier: 'UPS',
        shippedAt: '2026-06-12T09:00:00.000Z',
        occurredAt: '2026-06-12T09:00:01.000Z',
      });
    });

    it('falls back to a generic carrier phrase in the body when the carrier is null, keeping the metadata null', async () => {
      await useCase.shipped(buildShipped({ carrier: null }));

      const sent = notifier.sent[0];
      expect(sent.body).toContain('the carrier');
      expect(sent.metadata).toMatchObject({ carrier: null });
    });

    it('logs the correlationId on the dispatch line', async () => {
      await useCase.shipped(buildShipped({ correlationId: 'corr-ship-9' }));

      expect(logger.logs[0].context).toMatchObject({ correlationId: 'corr-ship-9' });
    });
  });

  describe('delivered', () => {
    it('dispatches a shipment-delivered notification carrying the order, fulfillment, and delivery time', async () => {
      await useCase.delivered(buildDelivered());

      expect(notifier.sent).toHaveLength(1);
      const sent = notifier.sent[0];

      expect(sent.recipient).toBe('order:4242');
      expect(sent.channel).toBe(NotificationChannelEnum.LOG);
      expect(sent.subject).toContain('delivered');
      expect(sent.subject).toContain('4242');
      expect(sent.body).toContain('77');
      expect(sent.body).toContain('2026-06-14T15:30:00.000Z');
      expect(sent.metadata).toEqual({
        orderId: 4242,
        fulfillmentId: 77,
        deliveredAt: '2026-06-14T15:30:00.000Z',
        occurredAt: '2026-06-14T15:30:01.000Z',
      });
    });

    it('logs the correlationId on the dispatch line', async () => {
      await useCase.delivered(buildDelivered({ correlationId: 'corr-deliver-9' }));

      expect(logger.logs[0].context).toMatchObject({ correlationId: 'corr-deliver-9' });
    });
  });
});
