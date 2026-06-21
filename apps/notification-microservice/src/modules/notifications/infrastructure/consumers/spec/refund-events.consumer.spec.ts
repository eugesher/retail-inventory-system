import { PinoLogger } from 'nestjs-pino';

import {
  IRetailRefundIssuedEvent,
  NotificationChannelEnum,
} from '@retail-inventory-system/contracts';
import { ROUTING_KEYS } from '@retail-inventory-system/messaging';

import { RenderAndDispatchUseCase } from '../../../application/use-cases';
import { RefundEventsConsumer } from '../refund-events.consumer';
import { FakeLogger, RecordingRenderAndDispatch } from './test-doubles';

describe('RefundEventsConsumer', () => {
  let renderAndDispatch: RecordingRenderAndDispatch;
  let logger: FakeLogger;
  let consumer: RefundEventsConsumer;

  beforeEach(() => {
    renderAndDispatch = new RecordingRenderAndDispatch();
    logger = new FakeLogger();
    consumer = new RefundEventsConsumer(
      renderAndDispatch as unknown as RenderAndDispatchUseCase,
      logger as unknown as PinoLogger,
    );
  });

  const buildEvent = (
    overrides: Partial<IRetailRefundIssuedEvent> = {},
  ): IRetailRefundIssuedEvent => ({
    correlationId: 'corr-refund-1',
    refundId: 33,
    orderId: 4242,
    paymentId: 99,
    customerEmail: 'buyer@example.com',
    customerLocale: null,
    amountMinor: 1000,
    currency: 'USD',
    issuedAt: '2026-06-18T10:00:00.000Z',
    eventVersion: 'v1',
    occurredAt: '2026-06-18T10:00:00.000Z',
    ...overrides,
  });

  it('maps the refund-issued event onto the render-and-dispatch input and delegates', async () => {
    const event = buildEvent();
    await consumer.onIssued(event);

    expect(renderAndDispatch.inputs).toHaveLength(1);
    expect(renderAndDispatch.inputs[0]).toEqual({
      eventType: ROUTING_KEYS.RETAIL_REFUND_ISSUED,
      channel: NotificationChannelEnum.EMAIL,
      // The refund event carries no `customerId`, so the row is not deduped.
      recipientCustomerId: null,
      recipientAddress: 'buyer@example.com',
      eventReferenceType: 'refund',
      eventReferenceId: '33',
      context: event,
      correlationId: 'corr-refund-1',
    });
  });

  it('skips and warn-logs when the buyer has no email', async () => {
    await consumer.onIssued(buildEvent({ customerEmail: null }));

    expect(renderAndDispatch.inputs).toHaveLength(0);
    expect(logger.warns).toHaveLength(1);
  });
});
