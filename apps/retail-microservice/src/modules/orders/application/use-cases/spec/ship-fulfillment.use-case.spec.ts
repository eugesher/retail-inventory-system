import { PinoLogger } from 'nestjs-pino';

import {
  FulfillmentStatusEnum,
  IRetailFulfillmentShipPayload,
  OrderFulfillmentStatusEnum,
  OrderLineStatusEnum,
  OrderPaymentStatusEnum,
  PaymentStatusEnum,
} from '@retail-inventory-system/contracts';
import { makePinoLoggerMock } from '@retail-inventory-system/observability/testing';

import {
  Fulfillment,
  Order,
  OrderDomainException,
  OrderErrorCodeEnum,
  Payment,
} from '../../../domain';
import { ShipFulfillmentUseCase } from '../ship-fulfillment.use-case';
import {
  buildOrderWithLinesFixture,
  buildPaymentFixture,
  FakeOrderCommitSaleGateway,
  FakeOrderRepository,
  FakeFulfillmentRepository,
  FakePaymentGateway,
  FakePaymentRepository,
  FakeTransactionPort,
  makeWireError,
  SpyOrderEventsPublisher,
} from './test-doubles';

const OWNER_ID = '00000000-0000-4000-a000-000000000002';
const STAFF_ID = '00000000-0000-4000-a000-000000000001';
const OTHER_ID = '00000000-0000-4000-a000-000000000099';
const ORDER_ID = 1;

// A single-line order (line 10 ordered 3) — the fixture sets `variantId === orderLineId`,
// so the commit-sale payload's variant for line 10 is 10.
const SINGLE_LINE_ORDER = (
  paymentStatus: OrderPaymentStatusEnum = OrderPaymentStatusEnum.AUTHORIZED,
  quantity = 3,
): Order =>
  buildOrderWithLinesFixture(ORDER_ID, OWNER_ID, [{ orderLineId: 10, quantity }], {
    paymentStatus,
  });

interface IHarness {
  useCase: ShipFulfillmentUseCase;
  orderRepository: FakeOrderRepository;
  fulfillmentRepository: FakeFulfillmentRepository;
  paymentRepository: FakePaymentRepository;
  paymentGateway: FakePaymentGateway;
  commitSaleGateway: FakeOrderCommitSaleGateway;
  publisher: SpyOrderEventsPublisher;
  fulfillmentId: number;
}

const makeHarness = async (
  opts: {
    order?: Order;
    payment?: Payment;
    fulfillmentLines?: { orderLineId: number; quantity: number }[];
    captureOk?: boolean;
  } = {},
): Promise<IHarness> => {
  const order = opts.order ?? SINGLE_LINE_ORDER();
  const logger = makePinoLoggerMock() as unknown as PinoLogger;
  const transactionPort = new FakeTransactionPort();
  const orderRepository = new FakeOrderRepository();
  const fulfillmentRepository = new FakeFulfillmentRepository();
  const paymentRepository = new FakePaymentRepository();
  const paymentGateway = new FakePaymentGateway(true, opts.captureOk ?? true);
  const commitSaleGateway = new FakeOrderCommitSaleGateway();
  const publisher = new SpyOrderEventsPublisher();

  await orderRepository.save(order);
  const payment =
    opts.payment ??
    buildPaymentFixture(900, order.id!, PaymentStatusEnum.AUTHORIZED, order.grandTotalMinor);
  await paymentRepository.save(payment);

  const saved = await fulfillmentRepository.save(
    Fulfillment.create({
      orderId: order.id!,
      stockLocationId: 'default-warehouse',
      lines: opts.fulfillmentLines ?? [{ orderLineId: 10, quantity: 3 }],
    }),
  );

  const useCase = new ShipFulfillmentUseCase(
    transactionPort,
    orderRepository,
    fulfillmentRepository,
    paymentRepository,
    paymentGateway,
    commitSaleGateway,
    publisher,
    logger,
  );
  return {
    useCase,
    orderRepository,
    fulfillmentRepository,
    paymentRepository,
    paymentGateway,
    commitSaleGateway,
    publisher,
    fulfillmentId: saved.id!,
  };
};

const shipPayload = (
  fulfillmentId: number,
  overrides: Partial<IRetailFulfillmentShipPayload> = {},
): IRetailFulfillmentShipPayload => ({
  orderId: ORDER_ID,
  fulfillmentId,
  trackingNumber: 'TRACK-123',
  carrier: 'UPS',
  actorId: OWNER_ID,
  isStaffFulfill: false,
  correlationId: 'corr-1',
  ...overrides,
});

describe('ShipFulfillmentUseCase', () => {
  describe('commit sale (after the local commit)', () => {
    it('ships the fulfillment and calls Commit Sale with the shipped lines', async () => {
      const h = await makeHarness();

      const view = await h.useCase.execute(shipPayload(h.fulfillmentId));

      expect(view.status).toBe(FulfillmentStatusEnum.SHIPPED);
      expect(view.trackingNumber).toBe('TRACK-123');
      expect(view.carrier).toBe('UPS');
      expect(view.shippedAt).not.toBeNull();

      // Commit Sale ran once, after the ship, with the variant from the order line
      // snapshot + the fulfillment's location.
      expect(h.commitSaleGateway.calls).toHaveLength(1);
      expect(h.commitSaleGateway.calls[0]).toMatchObject({
        orderId: ORDER_ID,
        fulfillmentId: String(h.fulfillmentId),
        lines: [{ variantId: 10, stockLocationId: 'default-warehouse', quantity: 3 }],
      });
      expect(h.publisher.fulfillmentShipped).toHaveLength(1);
    });

    it('does not roll the ship back when Commit Sale fails after retries', async () => {
      const h = await makeHarness();
      h.commitSaleGateway.commitError = makeWireError('STOCK_WRITE_CONFLICT', 409, 'busy');

      // The ship still resolves (the local commit is durable; the inventory decrement
      // awaits operator replay — idempotent on fulfillmentId).
      const view = await h.useCase.execute(shipPayload(h.fulfillmentId));

      expect(view.status).toBe(FulfillmentStatusEnum.SHIPPED);
      // Bounded retries were exhausted (3 attempts) but never threw.
      expect(h.commitSaleGateway.calls).toHaveLength(3);
      const shipped = await h.fulfillmentRepository.findById(h.fulfillmentId);
      expect(shipped?.status).toBe(FulfillmentStatusEnum.SHIPPED);
    });
  });

  describe('ship-triggered capture (Q5)', () => {
    it('captures an authorized payment inline and emits retail.payment.captured', async () => {
      const h = await makeHarness();

      await h.useCase.execute(shipPayload(h.fulfillmentId));

      expect(h.paymentGateway.captureCount).toBe(1);
      const payment = await h.paymentRepository.findByOrderId(ORDER_ID);
      expect(payment?.status).toBe(PaymentStatusEnum.CAPTURED);
      const order = await h.orderRepository.findById(ORDER_ID);
      expect(order?.paymentStatus).toBe(OrderPaymentStatusEnum.CAPTURED);
      expect(h.publisher.captured).toHaveLength(1);
    });

    it('skips the gateway when the payment is already captured', async () => {
      const h = await makeHarness({
        order: SINGLE_LINE_ORDER(OrderPaymentStatusEnum.CAPTURED),
        payment: buildPaymentFixture(900, ORDER_ID, PaymentStatusEnum.CAPTURED, 3000),
      });

      const view = await h.useCase.execute(shipPayload(h.fulfillmentId));

      // No second gateway call, no captured event — but the sale still commits.
      expect(h.paymentGateway.captureCount).toBe(0);
      expect(h.publisher.captured).toHaveLength(0);
      expect(h.commitSaleGateway.calls).toHaveLength(1);
      expect(view.status).toBe(FulfillmentStatusEnum.SHIPPED);
    });

    it('blocks the ship when the gateway declines the capture', async () => {
      const h = await makeHarness({ captureOk: false });

      await expect(h.useCase.execute(shipPayload(h.fulfillmentId))).rejects.toThrow(
        OrderDomainException,
      );

      // Block-ship-until-payment-succeeds: nothing transitioned, nothing committed.
      const fulfillment = await h.fulfillmentRepository.findById(h.fulfillmentId);
      expect(fulfillment?.status).toBe(FulfillmentStatusEnum.PENDING);
      expect(h.commitSaleGateway.calls).toHaveLength(0);
      expect(h.publisher.fulfillmentShipped).toHaveLength(0);
    });

    it('rejects a payment that is neither authorized nor captured', async () => {
      const h = await makeHarness({
        payment: buildPaymentFixture(900, ORDER_ID, PaymentStatusEnum.VOIDED, 3000),
      });

      await expect(h.useCase.execute(shipPayload(h.fulfillmentId))).rejects.toMatchObject({
        code: OrderErrorCodeEnum.PAYMENT_INVALID_STATUS_TRANSITION,
      });
    });
  });

  describe('status roll-up', () => {
    it('flips a fully-shipped line + the order axis to shipped', async () => {
      const h = await makeHarness();

      await h.useCase.execute(shipPayload(h.fulfillmentId));

      const order = await h.orderRepository.findById(ORDER_ID);
      expect(order?.lines[0].status).toBe(OrderLineStatusEnum.SHIPPED);
      expect(order?.fulfillmentStatus).toBe(OrderFulfillmentStatusEnum.SHIPPED);
    });

    it('flips a partially-shipped line + the order axis to partially-shipped', async () => {
      // Order line 10 ordered 5; ship only 2 → partial.
      const h = await makeHarness({
        order: SINGLE_LINE_ORDER(OrderPaymentStatusEnum.AUTHORIZED, 5),
        fulfillmentLines: [{ orderLineId: 10, quantity: 2 }],
      });

      await h.useCase.execute(shipPayload(h.fulfillmentId));

      const order = await h.orderRepository.findById(ORDER_ID);
      expect(order?.lines[0].status).toBe(OrderLineStatusEnum.PARTIALLY_SHIPPED);
      expect(order?.fulfillmentStatus).toBe(OrderFulfillmentStatusEnum.PARTIALLY_SHIPPED);
    });
  });

  describe('preconditions', () => {
    it('requires a tracking number to ship (400)', async () => {
      const h = await makeHarness();

      await expect(
        h.useCase.execute(shipPayload(h.fulfillmentId, { trackingNumber: undefined })),
      ).rejects.toMatchObject({ code: OrderErrorCodeEnum.FULFILLMENT_TRACKING_REQUIRED });

      // Tracking is checked before the out-of-process capture, so the money was never taken.
      expect(h.paymentGateway.captureCount).toBe(0);
      expect(h.commitSaleGateway.calls).toHaveLength(0);
    });

    it('rejects shipping a non-pending fulfillment (409)', async () => {
      const h = await makeHarness();
      await h.useCase.execute(shipPayload(h.fulfillmentId));

      // Shipping the same (now shipped) fulfillment again.
      await expect(h.useCase.execute(shipPayload(h.fulfillmentId))).rejects.toMatchObject({
        code: OrderErrorCodeEnum.FULFILLMENT_INVALID_STATUS_TRANSITION,
      });
    });

    it('rejects a fulfillment that does not belong to the order (404)', async () => {
      const h = await makeHarness();

      await expect(h.useCase.execute(shipPayload(h.fulfillmentId + 999))).rejects.toMatchObject({
        code: OrderErrorCodeEnum.FULFILLMENT_NOT_FOUND,
      });
    });
  });

  describe('authorization', () => {
    it('rejects a non-owner non-staff caller (403)', async () => {
      const h = await makeHarness();

      await expect(
        h.useCase.execute(shipPayload(h.fulfillmentId, { actorId: OTHER_ID })),
      ).rejects.toMatchObject({ code: OrderErrorCodeEnum.ORDER_ACCESS_FORBIDDEN });
    });

    it('lets staff ship any order via the order:fulfill override', async () => {
      const h = await makeHarness();

      const view = await h.useCase.execute(
        shipPayload(h.fulfillmentId, { actorId: STAFF_ID, isStaffFulfill: true }),
      );

      expect(view.status).toBe(FulfillmentStatusEnum.SHIPPED);
    });
  });
});
