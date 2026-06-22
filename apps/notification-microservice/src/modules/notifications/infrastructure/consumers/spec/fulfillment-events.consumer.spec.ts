import { PinoLogger } from 'nestjs-pino';

import {
  IRetailFulfillmentDeliveredEvent,
  IRetailFulfillmentShippedEvent,
  NotificationChannelEnum,
} from '@retail-inventory-system/contracts';
import { ROUTING_KEYS } from '@retail-inventory-system/messaging';

import { RenderAndDispatchUseCase } from '../../../application/use-cases';
import { FulfillmentEventsConsumer } from '../fulfillment-events.consumer';
import { FakeLogger, RecordingRenderAndDispatch } from './test-doubles';

describe('FulfillmentEventsConsumer', () => {
  let renderAndDispatch: RecordingRenderAndDispatch;
  let logger: FakeLogger;
  let consumer: FulfillmentEventsConsumer;

  beforeEach(() => {
    renderAndDispatch = new RecordingRenderAndDispatch();
    logger = new FakeLogger();
    consumer = new FulfillmentEventsConsumer(
      renderAndDispatch as unknown as RenderAndDispatchUseCase,
      logger as unknown as PinoLogger,
    );
  });

  const buildShipped = (
    overrides: Partial<IRetailFulfillmentShippedEvent> = {},
  ): IRetailFulfillmentShippedEvent => ({
    correlationId: 'corr-ship-1',
    orderId: 4242,
    fulfillmentId: 88,
    customerEmail: 'buyer@example.com',
    customerLocale: null,
    trackingNumber: '1Z-TRACK',
    carrier: 'UPS',
    shippedAt: '2026-06-12T10:00:00.000Z',
    eventVersion: 'v1',
    occurredAt: '2026-06-12T10:00:00.000Z',
    ...overrides,
  });

  const buildDelivered = (
    overrides: Partial<IRetailFulfillmentDeliveredEvent> = {},
  ): IRetailFulfillmentDeliveredEvent => ({
    correlationId: 'corr-deliver-1',
    orderId: 4242,
    fulfillmentId: 88,
    customerEmail: 'buyer@example.com',
    customerLocale: null,
    deliveredAt: '2026-06-13T10:00:00.000Z',
    eventVersion: 'v1',
    occurredAt: '2026-06-13T10:00:00.000Z',
    ...overrides,
  });

  it('maps the shipped event onto the render-and-dispatch input and delegates', async () => {
    const event = buildShipped();
    await consumer.onShipped(event);

    expect(renderAndDispatch.inputs).toHaveLength(1);
    expect(renderAndDispatch.inputs[0]).toEqual({
      eventType: ROUTING_KEYS.RETAIL_FULFILLMENT_SHIPPED,
      channel: NotificationChannelEnum.EMAIL,
      recipientCustomerId: null,
      recipientAddress: 'buyer@example.com',
      eventReferenceType: 'fulfillment',
      eventReferenceId: '88',
      context: event,
      correlationId: 'corr-ship-1',
    });
  });

  it('maps the delivered event onto the render-and-dispatch input and delegates', async () => {
    const event = buildDelivered();
    await consumer.onDelivered(event);

    expect(renderAndDispatch.inputs).toHaveLength(1);
    expect(renderAndDispatch.inputs[0]).toEqual({
      eventType: ROUTING_KEYS.RETAIL_FULFILLMENT_DELIVERED,
      channel: NotificationChannelEnum.EMAIL,
      recipientCustomerId: null,
      recipientAddress: 'buyer@example.com',
      eventReferenceType: 'fulfillment',
      eventReferenceId: '88',
      context: event,
      correlationId: 'corr-deliver-1',
    });
  });

  it('skips and warn-logs a shipped event with no buyer email', async () => {
    await consumer.onShipped(buildShipped({ customerEmail: null }));

    expect(renderAndDispatch.inputs).toHaveLength(0);
    expect(logger.warns).toHaveLength(1);
  });
});
