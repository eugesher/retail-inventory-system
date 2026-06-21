import { PinoLogger } from 'nestjs-pino';

import {
  IRetailReturnAuthorizedEvent,
  IRetailReturnInspectedEvent,
  IRetailReturnReceivedEvent,
  IRetailReturnRequestedEvent,
  NotificationChannelEnum,
} from '@retail-inventory-system/contracts';
import { ROUTING_KEYS } from '@retail-inventory-system/messaging';

import { RenderAndDispatchUseCase } from '../../../application/use-cases';
import { ReturnEventsConsumer } from '../return-events.consumer';
import { FakeLogger, RecordingRenderAndDispatch } from './test-doubles';

const CUSTOMER_ID = '22222222-2222-4222-8222-222222222222';

describe('ReturnEventsConsumer', () => {
  let renderAndDispatch: RecordingRenderAndDispatch;
  let logger: FakeLogger;
  let consumer: ReturnEventsConsumer;

  beforeEach(() => {
    renderAndDispatch = new RecordingRenderAndDispatch();
    logger = new FakeLogger();
    consumer = new ReturnEventsConsumer(
      renderAndDispatch as unknown as RenderAndDispatchUseCase,
      logger as unknown as PinoLogger,
    );
  });

  const requested = (
    overrides: Partial<IRetailReturnRequestedEvent> = {},
  ): IRetailReturnRequestedEvent => ({
    correlationId: 'corr-rma-req',
    rmaId: 7,
    rmaNumber: 'RMA-2026-00000007',
    orderId: 4242,
    customerId: CUSTOMER_ID,
    customerEmail: 'buyer@example.com',
    customerLocale: null,
    requestedAt: '2026-06-14T10:00:00.000Z',
    lineCount: 1,
    eventVersion: 'v1',
    occurredAt: '2026-06-14T10:00:00.000Z',
    ...overrides,
  });

  const authorized = (): IRetailReturnAuthorizedEvent => ({
    correlationId: 'corr-rma-auth',
    rmaId: 7,
    rmaNumber: 'RMA-2026-00000007',
    orderId: 4242,
    customerId: CUSTOMER_ID,
    customerEmail: 'buyer@example.com',
    customerLocale: null,
    authorizedAt: '2026-06-15T10:00:00.000Z',
    eventVersion: 'v1',
    occurredAt: '2026-06-15T10:00:00.000Z',
  });

  const received = (): IRetailReturnReceivedEvent => ({
    correlationId: 'corr-rma-recv',
    rmaId: 7,
    rmaNumber: 'RMA-2026-00000007',
    orderId: 4242,
    customerId: CUSTOMER_ID,
    customerEmail: 'buyer@example.com',
    customerLocale: null,
    receivedAt: '2026-06-16T10:00:00.000Z',
    eventVersion: 'v1',
    occurredAt: '2026-06-16T10:00:00.000Z',
  });

  const inspected = (): IRetailReturnInspectedEvent => ({
    correlationId: 'corr-rma-insp',
    rmaId: 7,
    rmaNumber: 'RMA-2026-00000007',
    orderId: 4242,
    customerId: CUSTOMER_ID,
    customerEmail: 'buyer@example.com',
    customerLocale: null,
    inspectedAt: '2026-06-17T10:00:00.000Z',
    restockedLineCount: 1,
    eventVersion: 'v1',
    occurredAt: '2026-06-17T10:00:00.000Z',
  });

  it('maps the requested event with the customerId as the dedupe anchor', async () => {
    const event = requested();
    await consumer.onRequested(event);

    expect(renderAndDispatch.inputs[0]).toEqual({
      eventType: ROUTING_KEYS.RETAIL_RETURN_REQUESTED,
      channel: NotificationChannelEnum.EMAIL,
      recipientCustomerId: CUSTOMER_ID,
      recipientAddress: 'buyer@example.com',
      eventReferenceType: 'return-request',
      eventReferenceId: '7',
      context: event,
      correlationId: 'corr-rma-req',
    });
  });

  it('keys each return handler on its own template eventType against the rmaId', async () => {
    await consumer.onAuthorized(authorized());
    await consumer.onReceived(received());
    await consumer.onInspected(inspected());

    expect(renderAndDispatch.inputs.map((i) => i.eventType)).toEqual([
      ROUTING_KEYS.RETAIL_RETURN_AUTHORIZED,
      ROUTING_KEYS.RETAIL_RETURN_RECEIVED,
      ROUTING_KEYS.RETAIL_RETURN_INSPECTED,
    ]);
    for (const input of renderAndDispatch.inputs) {
      expect(input.eventReferenceType).toBe('return-request');
      expect(input.eventReferenceId).toBe('7');
      expect(input.recipientCustomerId).toBe(CUSTOMER_ID);
    }
  });

  it('skips and warn-logs a requested event with no buyer email', async () => {
    await consumer.onRequested(requested({ customerEmail: null }));

    expect(renderAndDispatch.inputs).toHaveLength(0);
    expect(logger.warns).toHaveLength(1);
  });
});
