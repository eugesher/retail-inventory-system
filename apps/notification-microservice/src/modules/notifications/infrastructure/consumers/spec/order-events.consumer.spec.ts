import { PinoLogger } from 'nestjs-pino';

import {
  IRetailOrderPlacedEvent,
  NotificationChannelEnum,
} from '@retail-inventory-system/contracts';
import { ROUTING_KEYS } from '@retail-inventory-system/messaging';

import { RenderAndDispatchUseCase } from '../../../application/use-cases';
import { OrderEventsConsumer } from '../order-events.consumer';
import { FakeLogger, RecordingRenderAndDispatch } from './test-doubles';

describe('OrderEventsConsumer', () => {
  let renderAndDispatch: RecordingRenderAndDispatch;
  let logger: FakeLogger;
  let consumer: OrderEventsConsumer;

  beforeEach(() => {
    renderAndDispatch = new RecordingRenderAndDispatch();
    logger = new FakeLogger();
    consumer = new OrderEventsConsumer(
      renderAndDispatch as unknown as RenderAndDispatchUseCase,
      logger as unknown as PinoLogger,
    );
  });

  const buildEvent = (
    overrides: Partial<IRetailOrderPlacedEvent> = {},
  ): IRetailOrderPlacedEvent => ({
    correlationId: 'corr-order-1',
    orderId: 4242,
    orderNumber: 'ORD-2026-00004242',
    customerId: '11111111-1111-4111-8111-111111111111',
    customerEmail: 'buyer@example.com',
    customerLocale: null,
    grandTotalMinor: 29997,
    currency: 'USD',
    lineCount: 2,
    eventVersion: 'v1',
    occurredAt: '2026-06-10T12:00:00.000Z',
    ...overrides,
  });

  it('maps the order-placed event onto the render-and-dispatch input and delegates', async () => {
    const event = buildEvent();
    await consumer.onOrderPlaced(event);

    expect(renderAndDispatch.inputs).toHaveLength(1);
    expect(renderAndDispatch.inputs[0]).toEqual({
      eventType: ROUTING_KEYS.RETAIL_ORDER_PLACED,
      channel: NotificationChannelEnum.EMAIL,
      recipientCustomerId: '11111111-1111-4111-8111-111111111111',
      recipientAddress: 'buyer@example.com',
      eventReferenceType: 'order',
      eventReferenceId: '4242',
      context: event,
      correlationId: 'corr-order-1',
    });
  });

  it('skips and warn-logs when the buyer has no email (a tombstoned/guest customer)', async () => {
    await consumer.onOrderPlaced(
      buildEvent({ customerEmail: null, correlationId: 'corr-order-9' }),
    );

    expect(renderAndDispatch.inputs).toHaveLength(0);
    expect(logger.warns).toHaveLength(1);
    expect(logger.warns[0].context).toMatchObject({ correlationId: 'corr-order-9' });
  });
});
