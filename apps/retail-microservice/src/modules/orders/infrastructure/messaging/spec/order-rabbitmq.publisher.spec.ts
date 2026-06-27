import { ClientProxy } from '@nestjs/microservices';
import { PinoLogger } from 'nestjs-pino';
import { of } from 'rxjs';

import {
  ICorrelationPayload,
  IRetailFulfillmentCreatedEvent,
  IRetailFulfillmentDeliveredEvent,
  IRetailFulfillmentShippedEvent,
  IRetailOrderCancelledEvent,
  IRetailOrderPlacedEvent,
  IRetailPaymentAuthorizedEvent,
  IRetailPaymentCapturedEvent,
  IRetailRefundFailedEvent,
  IRetailRefundIssuedEvent,
} from '@retail-inventory-system/contracts';
import { RisEventsMirrorPublisher, ROUTING_KEYS } from '@retail-inventory-system/messaging';
import { makePinoLoggerMock } from '@retail-inventory-system/observability/testing';

import { OrderRabbitmqPublisher } from '../order-rabbitmq.publisher';

// Proves the orders publisher dual-publishes (ADR-035): every
// order/payment/fulfillment/refund event keeps its primary emit AND mirrors the
// same routing key + wire onto `ris.events`. The dual-emitted
// `retail.order.cancelled` (two queue destinations) is mirrored exactly **once**.
describe('OrderRabbitmqPublisher dual-publish', () => {
  let notificationEmit: jest.Mock;
  let retailEmit: jest.Mock;
  let mirror: RisEventsMirrorPublisher;
  let mirrorSpy: jest.SpyInstance;
  let publisher: OrderRabbitmqPublisher;

  beforeEach(() => {
    notificationEmit = jest.fn().mockReturnValue(of(undefined));
    retailEmit = jest.fn().mockReturnValue(of(undefined));
    mirror = new RisEventsMirrorPublisher(
      { emit: jest.fn().mockReturnValue(of(undefined)) } as unknown as ClientProxy,
      makePinoLoggerMock() as unknown as PinoLogger,
    );
    mirrorSpy = jest.spyOn(mirror, 'mirror');
    publisher = new OrderRabbitmqPublisher(
      { emit: notificationEmit } as unknown as ClientProxy,
      { emit: retailEmit } as unknown as ClientProxy,
      mirror,
    );
  });

  const event = <T>(): T => ({ correlationId: 'cid' }) as unknown as T;

  const placed = event<IRetailOrderPlacedEvent>();
  const paymentAuthorized = event<IRetailPaymentAuthorizedEvent>();
  const paymentCaptured = event<IRetailPaymentCapturedEvent>();
  const fulfillmentCreated = event<IRetailFulfillmentCreatedEvent>();
  const fulfillmentShipped = event<IRetailFulfillmentShippedEvent>();
  const fulfillmentDelivered = event<IRetailFulfillmentDeliveredEvent>();
  const refundIssued = event<IRetailRefundIssuedEvent>();
  const refundFailed = event<IRetailRefundFailedEvent>();

  interface ICase {
    name: string;
    routingKey: string;
    primary: () => jest.Mock;
    payload: ICorrelationPayload;
    invoke: () => Promise<void>;
  }

  const cases: ICase[] = [
    {
      name: 'order.placed',
      routingKey: ROUTING_KEYS.RETAIL_ORDER_PLACED,
      primary: () => notificationEmit,
      payload: placed,
      invoke: () => publisher.publishOrderPlaced(placed),
    },
    {
      name: 'payment.authorized',
      routingKey: ROUTING_KEYS.RETAIL_PAYMENT_AUTHORIZED,
      primary: () => retailEmit,
      payload: paymentAuthorized,
      invoke: () => publisher.publishPaymentAuthorized(paymentAuthorized),
    },
    {
      name: 'payment.captured',
      routingKey: ROUTING_KEYS.RETAIL_PAYMENT_CAPTURED,
      primary: () => retailEmit,
      payload: paymentCaptured,
      invoke: () => publisher.publishPaymentCaptured(paymentCaptured),
    },
    {
      name: 'fulfillment.created',
      routingKey: ROUTING_KEYS.RETAIL_FULFILLMENT_CREATED,
      primary: () => retailEmit,
      payload: fulfillmentCreated,
      invoke: () => publisher.publishFulfillmentCreated(fulfillmentCreated),
    },
    {
      name: 'fulfillment.shipped',
      routingKey: ROUTING_KEYS.RETAIL_FULFILLMENT_SHIPPED,
      primary: () => notificationEmit,
      payload: fulfillmentShipped,
      invoke: () => publisher.publishFulfillmentShipped(fulfillmentShipped),
    },
    {
      name: 'fulfillment.delivered',
      routingKey: ROUTING_KEYS.RETAIL_FULFILLMENT_DELIVERED,
      primary: () => notificationEmit,
      payload: fulfillmentDelivered,
      invoke: () => publisher.publishFulfillmentDelivered(fulfillmentDelivered),
    },
    {
      name: 'refund.issued',
      routingKey: ROUTING_KEYS.RETAIL_REFUND_ISSUED,
      primary: () => notificationEmit,
      payload: refundIssued,
      invoke: () => publisher.publishRefundIssued(refundIssued),
    },
    {
      name: 'refund.failed',
      routingKey: ROUTING_KEYS.RETAIL_REFUND_FAILED,
      primary: () => retailEmit,
      payload: refundFailed,
      invoke: () => publisher.publishRefundFailed(refundFailed),
    },
  ];

  it.each(cases)(
    'mirrors $name onto ris.events alongside the primary emit',
    async ({ routingKey, primary, payload, invoke }) => {
      await invoke();

      expect(primary()).toHaveBeenCalledWith(routingKey, payload);
      expect(mirrorSpy).toHaveBeenCalledTimes(1);
      expect(mirrorSpy).toHaveBeenCalledWith(routingKey, payload);
    },
  );

  it('mirrors the dual-emitted order.cancelled exactly once', async () => {
    const cancelled = event<IRetailOrderCancelledEvent>();

    await publisher.publishOrderCancelled(cancelled);

    // Two queue destinations for the one logical event...
    expect(retailEmit).toHaveBeenCalledWith(ROUTING_KEYS.RETAIL_ORDER_CANCELLED, cancelled);
    expect(notificationEmit).toHaveBeenCalledWith(ROUTING_KEYS.RETAIL_ORDER_CANCELLED, cancelled);
    // ...but a single firehose mirror.
    expect(mirrorSpy).toHaveBeenCalledTimes(1);
    expect(mirrorSpy).toHaveBeenCalledWith(ROUTING_KEYS.RETAIL_ORDER_CANCELLED, cancelled);
  });
});
