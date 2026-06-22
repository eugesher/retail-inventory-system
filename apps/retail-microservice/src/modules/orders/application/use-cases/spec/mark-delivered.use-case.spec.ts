import { PinoLogger } from 'nestjs-pino';

import {
  FulfillmentStatusEnum,
  IRetailFulfillmentDeliverPayload,
  OrderFulfillmentStatusEnum,
  OrderPaymentStatusEnum,
  OrderStatusEnum,
} from '@retail-inventory-system/contracts';
import { makePinoLoggerMock } from '@retail-inventory-system/observability/testing';

import { Fulfillment, Order, OrderErrorCodeEnum } from '../../../domain';
import { MarkDeliveredUseCase } from '../mark-delivered.use-case';
import {
  buildOrderWithLinesFixture,
  FAKE_CUSTOMER_EMAIL,
  FakeCustomerContactReader,
  FakeFulfillmentRepository,
  FakeOrderRepository,
  FakeTransactionPort,
  SpyOrderEventsPublisher,
} from './test-doubles';

const OWNER_ID = '00000000-0000-4000-a000-000000000002';
const STAFF_ID = '00000000-0000-4000-a000-000000000001';
const OTHER_ID = '00000000-0000-4000-a000-000000000099';
const ORDER_ID = 1;

interface IHarness {
  useCase: MarkDeliveredUseCase;
  orderRepository: FakeOrderRepository;
  fulfillmentRepository: FakeFulfillmentRepository;
  publisher: SpyOrderEventsPublisher;
  customerContactReader: FakeCustomerContactReader;
}

const makeHarness = async (order: Order): Promise<IHarness> => {
  const logger = makePinoLoggerMock() as unknown as PinoLogger;
  const orderRepository = new FakeOrderRepository();
  const fulfillmentRepository = new FakeFulfillmentRepository();
  const publisher = new SpyOrderEventsPublisher();
  const customerContactReader = new FakeCustomerContactReader();
  await orderRepository.save(order);

  const useCase = new MarkDeliveredUseCase(
    new FakeTransactionPort(),
    orderRepository,
    fulfillmentRepository,
    publisher,
    customerContactReader,
    logger,
  );
  return { useCase, orderRepository, fulfillmentRepository, publisher, customerContactReader };
};

// Persists a SHIPPED fulfillment for the order (the only state Deliver accepts).
const addShippedFulfillment = async (
  repo: FakeFulfillmentRepository,
  orderId: number,
  lines: { orderLineId: number; quantity: number }[],
): Promise<number> => {
  const fulfillment = Fulfillment.create({ orderId, stockLocationId: 'default-warehouse', lines });
  fulfillment.ship({ trackingNumber: 'TRACK-1', carrier: 'UPS', shippedAt: new Date() });
  const saved = await repo.save(fulfillment);
  return saved.id!;
};

const deliverPayload = (
  fulfillmentId: number,
  overrides: Partial<IRetailFulfillmentDeliverPayload> = {},
): IRetailFulfillmentDeliverPayload => ({
  orderId: ORDER_ID,
  fulfillmentId,
  actorId: OWNER_ID,
  isStaffFulfill: false,
  correlationId: 'corr-1',
  ...overrides,
});

describe('MarkDeliveredUseCase', () => {
  describe('order roll-up', () => {
    it('delivers a single-fulfillment order and flips the order → delivered', async () => {
      const order = buildOrderWithLinesFixture(
        ORDER_ID,
        OWNER_ID,
        [{ orderLineId: 10, quantity: 3 }],
        {
          paymentStatus: OrderPaymentStatusEnum.CAPTURED,
          fulfillmentStatus: OrderFulfillmentStatusEnum.SHIPPED,
        },
      );
      const h = await makeHarness(order);
      const fulfillmentId = await addShippedFulfillment(h.fulfillmentRepository, ORDER_ID, [
        { orderLineId: 10, quantity: 3 },
      ]);

      const view = await h.useCase.execute(deliverPayload(fulfillmentId));

      expect(view.status).toBe(FulfillmentStatusEnum.DELIVERED);
      expect(view.deliveredAt).not.toBeNull();

      // The only fulfillment is now delivered → the order rolls up to delivered on both axes.
      const reread = await h.orderRepository.findById(ORDER_ID);
      expect(reread?.status).toBe(OrderStatusEnum.DELIVERED);
      expect(reread?.fulfillmentStatus).toBe(OrderFulfillmentStatusEnum.DELIVERED);
      expect(h.publisher.fulfillmentDelivered).toHaveLength(1);
      // The buyer's email was resolved from the order's customerId and stamped on the
      // delivery event (ADR-033); locale ships null.
      expect(h.publisher.fulfillmentDelivered[0]).toMatchObject({
        customerEmail: FAKE_CUSTOMER_EMAIL,
        customerLocale: null,
      });
      expect(h.customerContactReader.calls).toEqual([OWNER_ID]);
    });

    it('keeps a multi-fulfillment order non-delivered until every fulfillment is delivered', async () => {
      const order = buildOrderWithLinesFixture(
        ORDER_ID,
        OWNER_ID,
        [{ orderLineId: 10, quantity: 5 }],
        {
          paymentStatus: OrderPaymentStatusEnum.CAPTURED,
          fulfillmentStatus: OrderFulfillmentStatusEnum.SHIPPED,
        },
      );
      const h = await makeHarness(order);
      const first = await addShippedFulfillment(h.fulfillmentRepository, ORDER_ID, [
        { orderLineId: 10, quantity: 3 },
      ]);
      const second = await addShippedFulfillment(h.fulfillmentRepository, ORDER_ID, [
        { orderLineId: 10, quantity: 2 },
      ]);

      // Deliver only the first — a shipped sibling remains, so the order stays put.
      await h.useCase.execute(deliverPayload(first));
      let reread = await h.orderRepository.findById(ORDER_ID);
      expect(reread?.status).toBe(OrderStatusEnum.PENDING);
      expect(reread?.fulfillmentStatus).toBe(OrderFulfillmentStatusEnum.SHIPPED);

      // Deliver the second — now every fulfillment is delivered → the order rolls up.
      await h.useCase.execute(deliverPayload(second));
      reread = await h.orderRepository.findById(ORDER_ID);
      expect(reread?.status).toBe(OrderStatusEnum.DELIVERED);
      expect(reread?.fulfillmentStatus).toBe(OrderFulfillmentStatusEnum.DELIVERED);
    });
  });

  describe('preconditions', () => {
    it('rejects delivering a non-shipped (pending) fulfillment (409)', async () => {
      const order = buildOrderWithLinesFixture(
        ORDER_ID,
        OWNER_ID,
        [{ orderLineId: 10, quantity: 3 }],
        {
          fulfillmentStatus: OrderFulfillmentStatusEnum.UNFULFILLED,
        },
      );
      const h = await makeHarness(order);
      const pending = await h.fulfillmentRepository.save(
        Fulfillment.create({
          orderId: ORDER_ID,
          stockLocationId: 'default-warehouse',
          lines: [{ orderLineId: 10, quantity: 3 }],
        }),
      );

      await expect(h.useCase.execute(deliverPayload(pending.id!))).rejects.toMatchObject({
        code: OrderErrorCodeEnum.FULFILLMENT_INVALID_STATUS_TRANSITION,
      });
    });

    it('rejects a fulfillment that does not belong to the order (404)', async () => {
      const order = buildOrderWithLinesFixture(
        ORDER_ID,
        OWNER_ID,
        [{ orderLineId: 10, quantity: 3 }],
        {
          fulfillmentStatus: OrderFulfillmentStatusEnum.SHIPPED,
        },
      );
      const h = await makeHarness(order);
      const fulfillmentId = await addShippedFulfillment(h.fulfillmentRepository, ORDER_ID, [
        { orderLineId: 10, quantity: 3 },
      ]);

      await expect(h.useCase.execute(deliverPayload(fulfillmentId + 999))).rejects.toMatchObject({
        code: OrderErrorCodeEnum.FULFILLMENT_NOT_FOUND,
      });
    });
  });

  describe('authorization', () => {
    it('rejects a non-owner non-staff caller (403)', async () => {
      const order = buildOrderWithLinesFixture(
        ORDER_ID,
        OWNER_ID,
        [{ orderLineId: 10, quantity: 3 }],
        {
          fulfillmentStatus: OrderFulfillmentStatusEnum.SHIPPED,
        },
      );
      const h = await makeHarness(order);
      const fulfillmentId = await addShippedFulfillment(h.fulfillmentRepository, ORDER_ID, [
        { orderLineId: 10, quantity: 3 },
      ]);

      await expect(
        h.useCase.execute(deliverPayload(fulfillmentId, { actorId: OTHER_ID })),
      ).rejects.toMatchObject({ code: OrderErrorCodeEnum.ORDER_ACCESS_FORBIDDEN });
    });

    it('lets staff deliver any order via the order:fulfill override', async () => {
      const order = buildOrderWithLinesFixture(
        ORDER_ID,
        OWNER_ID,
        [{ orderLineId: 10, quantity: 3 }],
        {
          fulfillmentStatus: OrderFulfillmentStatusEnum.SHIPPED,
        },
      );
      const h = await makeHarness(order);
      const fulfillmentId = await addShippedFulfillment(h.fulfillmentRepository, ORDER_ID, [
        { orderLineId: 10, quantity: 3 },
      ]);

      const view = await h.useCase.execute(
        deliverPayload(fulfillmentId, { actorId: STAFF_ID, isStaffFulfill: true }),
      );

      expect(view.status).toBe(FulfillmentStatusEnum.DELIVERED);
    });
  });
});
