import { PinoLogger } from 'nestjs-pino';

import {
  IRetailOrderCancelledEvent,
  NotificationChannelEnum,
} from '@retail-inventory-system/contracts';
import { ROUTING_KEYS } from '@retail-inventory-system/messaging';

import { RenderAndDispatchUseCase } from '../../../application/use-cases';
import { OrderCancelledNotificationConsumer } from '../order-cancelled-events.consumer';
import { FakeLogger, RecordingRenderAndDispatch } from './test-doubles';

describe('OrderCancelledNotificationConsumer', () => {
  let renderAndDispatch: RecordingRenderAndDispatch;
  let logger: FakeLogger;
  let consumer: OrderCancelledNotificationConsumer;

  beforeEach(() => {
    renderAndDispatch = new RecordingRenderAndDispatch();
    logger = new FakeLogger();
    consumer = new OrderCancelledNotificationConsumer(
      renderAndDispatch as unknown as RenderAndDispatchUseCase,
      logger as unknown as PinoLogger,
    );
  });

  const buildEvent = (
    overrides: Partial<IRetailOrderCancelledEvent> = {},
  ): IRetailOrderCancelledEvent => ({
    correlationId: 'corr-cancel-1',
    orderId: 5151,
    customerEmail: 'buyer@example.com',
    customerLocale: null,
    cancelledAt: '2026-06-11T09:00:00.000Z',
    reason: 'changed mind',
    paymentFlaggedForRefund: true,
    eventVersion: 'v1',
    occurredAt: '2026-06-11T09:00:00.000Z',
    ...overrides,
  });

  it('maps the cancelled event onto the render-and-dispatch input and delegates', async () => {
    const event = buildEvent();
    await consumer.onCancelled(event);

    expect(renderAndDispatch.inputs).toHaveLength(1);
    expect(renderAndDispatch.inputs[0]).toEqual({
      eventType: ROUTING_KEYS.RETAIL_ORDER_CANCELLED,
      channel: NotificationChannelEnum.EMAIL,
      // The cancelled wire contract carries no `customerId`, so the row is not deduped.
      recipientCustomerId: null,
      recipientAddress: 'buyer@example.com',
      eventReferenceType: 'order',
      eventReferenceId: '5151',
      context: event,
      correlationId: 'corr-cancel-1',
    });
  });

  it('skips and warn-logs when the buyer has no email', async () => {
    await consumer.onCancelled(buildEvent({ customerEmail: null, correlationId: 'corr-cancel-9' }));

    expect(renderAndDispatch.inputs).toHaveLength(0);
    expect(logger.warns).toHaveLength(1);
    expect(logger.warns[0].context).toMatchObject({ correlationId: 'corr-cancel-9' });
  });
});
