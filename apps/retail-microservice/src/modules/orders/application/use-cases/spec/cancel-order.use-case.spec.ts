import { PinoLogger } from 'nestjs-pino';

import {
  FulfillmentStatusEnum,
  IRetailOrderCancelPayload,
  OrderPaymentStatusEnum,
  OrderStatusEnum,
  PaymentStatusEnum,
} from '@retail-inventory-system/contracts';
import { makePinoLoggerMock } from '@retail-inventory-system/observability/testing';

import { Fulfillment, Order, OrderErrorCodeEnum, Payment } from '../../../domain';
import { CancelOrderUseCase } from '../cancel-order.use-case';
import {
  buildOrderWithLinesFixture,
  buildPaymentFixture,
  FakeFulfillmentRepository,
  FakeOrderInventoryGateway,
  FakeOrderRepository,
  FakePaymentRepository,
  FakeTransactionPort,
  SpyOrderEventsPublisher,
} from './test-doubles';

const OWNER_ID = '00000000-0000-4000-a000-000000000002';
const STAFF_ID = '00000000-0000-4000-a000-000000000001';
const OTHER_ID = '00000000-0000-4000-a000-000000000099';
const ORDER_ID = 1;

interface IHarness {
  useCase: CancelOrderUseCase;
  orderRepository: FakeOrderRepository;
  fulfillmentRepository: FakeFulfillmentRepository;
  paymentRepository: FakePaymentRepository;
  inventoryGateway: FakeOrderInventoryGateway;
  publisher: SpyOrderEventsPublisher;
}

const makeHarness = async (
  opts: { order?: Order; payment?: Payment | null } = {},
): Promise<IHarness> => {
  const order =
    opts.order ??
    buildOrderWithLinesFixture(ORDER_ID, OWNER_ID, [{ orderLineId: 10, quantity: 2 }]);
  const logger = makePinoLoggerMock() as unknown as PinoLogger;
  const orderRepository = new FakeOrderRepository();
  const fulfillmentRepository = new FakeFulfillmentRepository();
  const paymentRepository = new FakePaymentRepository();
  const inventoryGateway = new FakeOrderInventoryGateway();
  const publisher = new SpyOrderEventsPublisher();

  await orderRepository.save(order);
  // `null` opts.payment means "no payment row" (a bare placed order before authorize).
  const payment =
    opts.payment === undefined
      ? buildPaymentFixture(900, ORDER_ID, PaymentStatusEnum.AUTHORIZED, order.grandTotalMinor)
      : opts.payment;
  if (payment) {
    await paymentRepository.save(payment);
  }

  const useCase = new CancelOrderUseCase(
    new FakeTransactionPort(),
    orderRepository,
    fulfillmentRepository,
    paymentRepository,
    inventoryGateway,
    publisher,
    logger,
  );
  return {
    useCase,
    orderRepository,
    fulfillmentRepository,
    paymentRepository,
    inventoryGateway,
    publisher,
  };
};

const cancelPayload = (
  overrides: Partial<IRetailOrderCancelPayload> = {},
): IRetailOrderCancelPayload => ({
  orderId: ORDER_ID,
  reason: 'changed-my-mind',
  actorId: OWNER_ID,
  isStaffCancel: false,
  correlationId: 'corr-1',
  ...overrides,
});

describe('CancelOrderUseCase', () => {
  describe('happy path (authorized payment)', () => {
    it('voids the payment, releases the allocation, and emits cancelled (flagged=false)', async () => {
      const h = await makeHarness();

      const view = await h.useCase.execute(cancelPayload());

      expect(view.status).toBe(OrderStatusEnum.CANCELLED);

      // Authorized → voided (no money taken), not flagged.
      const payment = await h.paymentRepository.findByOrderId(ORDER_ID);
      expect(payment?.status).toBe(PaymentStatusEnum.VOIDED);
      expect(payment?.flaggedForRefund).toBe(false);

      // Allocation released for the order's lines (variantId === orderLineId in the fixture).
      expect(h.inventoryGateway.cancelCalls).toHaveLength(1);
      expect(h.inventoryGateway.cancelCalls[0]).toMatchObject({
        orderId: ORDER_ID,
        reason: 'order-cancelled',
        lines: [{ variantId: 10, stockLocationId: 'default-warehouse', quantity: 2 }],
      });

      expect(h.publisher.orderCancelled).toHaveLength(1);
      expect(h.publisher.orderCancelled[0]).toMatchObject({
        orderId: ORDER_ID,
        reason: 'changed-my-mind',
        paymentFlaggedForRefund: false,
      });
    });

    it('cancels a pending fulfillment along with the order', async () => {
      const h = await makeHarness();
      const pending = await h.fulfillmentRepository.save(
        Fulfillment.create({
          orderId: ORDER_ID,
          stockLocationId: 'default-warehouse',
          lines: [{ orderLineId: 10, quantity: 1 }],
        }),
      );

      await h.useCase.execute(cancelPayload());

      const reread = await h.fulfillmentRepository.findById(pending.id!);
      expect(reread?.status).toBe(FulfillmentStatusEnum.CANCELLED);
    });
  });

  describe('captured payment', () => {
    it('flags the payment for refund (flagged=true, no void) and emits flagged=true', async () => {
      const h = await makeHarness({
        payment: buildPaymentFixture(900, ORDER_ID, PaymentStatusEnum.CAPTURED, 2000),
      });

      const view = await h.useCase.execute(cancelPayload());

      expect(view.status).toBe(OrderStatusEnum.CANCELLED);

      const payment = await h.paymentRepository.findByOrderId(ORDER_ID);
      // The money is gone — the row stays captured but is flagged for the later refund.
      expect(payment?.status).toBe(PaymentStatusEnum.CAPTURED);
      expect(payment?.flaggedForRefund).toBe(true);

      expect(h.publisher.orderCancelled[0]).toMatchObject({ paymentFlaggedForRefund: true });
      // The allocation is still released regardless of the payment outcome.
      expect(h.inventoryGateway.cancelCalls).toHaveLength(1);
    });
  });

  describe('precondition: a shipped fulfillment blocks the cancel', () => {
    it('rejects with ORDER_NOT_CANCELLABLE (409) and writes nothing', async () => {
      const h = await makeHarness();
      const shipped = Fulfillment.create({
        orderId: ORDER_ID,
        stockLocationId: 'default-warehouse',
        lines: [{ orderLineId: 10, quantity: 1 }],
      });
      shipped.ship({ trackingNumber: 'TRACK-1', carrier: null, shippedAt: new Date() });
      await h.fulfillmentRepository.save(shipped);

      await expect(h.useCase.execute(cancelPayload())).rejects.toMatchObject({
        code: OrderErrorCodeEnum.ORDER_NOT_CANCELLABLE,
      });

      // Nothing was settled or released.
      const order = await h.orderRepository.findById(ORDER_ID);
      expect(order?.status).toBe(OrderStatusEnum.PENDING);
      const payment = await h.paymentRepository.findByOrderId(ORDER_ID);
      expect(payment?.status).toBe(PaymentStatusEnum.AUTHORIZED);
      expect(h.inventoryGateway.cancelCalls).toHaveLength(0);
    });
  });

  describe('authorization', () => {
    it('lets the owner cancel its own pending order', async () => {
      const h = await makeHarness();

      const view = await h.useCase.execute(
        cancelPayload({ actorId: OWNER_ID, isStaffCancel: false }),
      );

      expect(view.status).toBe(OrderStatusEnum.CANCELLED);
    });

    it('rejects a non-owner non-staff caller (403)', async () => {
      const h = await makeHarness();

      await expect(
        h.useCase.execute(cancelPayload({ actorId: OTHER_ID, isStaffCancel: false })),
      ).rejects.toMatchObject({ code: OrderErrorCodeEnum.ORDER_ACCESS_FORBIDDEN });
    });

    it('lets staff cancel any order via the order:cancel override', async () => {
      const h = await makeHarness();

      const view = await h.useCase.execute(
        cancelPayload({ actorId: STAFF_ID, isStaffCancel: true }),
      );

      expect(view.status).toBe(OrderStatusEnum.CANCELLED);
    });
  });

  // Defensive: a placed order always carries a payment, but the cancel must not blow up
  // if one is somehow absent — it simply skips the payment settlement.
  describe('no payment row', () => {
    it('cancels and releases the allocation with flagged=false', async () => {
      const h = await makeHarness({ payment: null });

      const view = await h.useCase.execute(cancelPayload());

      expect(view.status).toBe(OrderStatusEnum.CANCELLED);
      expect(view.paymentStatus).toBe(OrderPaymentStatusEnum.AUTHORIZED);
      expect(h.inventoryGateway.cancelCalls).toHaveLength(1);
      expect(h.publisher.orderCancelled[0]).toMatchObject({ paymentFlaggedForRefund: false });
    });
  });
});
