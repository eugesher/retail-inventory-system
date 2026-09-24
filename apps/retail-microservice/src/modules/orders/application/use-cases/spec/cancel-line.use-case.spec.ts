import { PinoLogger } from 'nestjs-pino';

import {
  IRetailOrderCancelLinePayload,
  OrderLineStatusEnum,
} from '@retail-inventory-system/contracts';
import { makePinoLoggerMock } from '@retail-inventory-system/observability/testing';

import { Fulfillment, Order, OrderErrorCodeEnum, OrderLine } from '../../../domain';
import { CancelLineUseCase } from '../cancel-line.use-case';
import {
  buildOrderWithLinesFixture,
  FakeFulfillmentRepository,
  FakeOrderInventoryGateway,
  FakeOrderRepository,
  FakePaymentRepository,
  RollbackFakeTransactionPort,
} from './test-doubles';

const STAFF_ID = '00000000-0000-4000-a000-000000000001';
const ORDER_ID = 1;
const LINE_ID = 10;
const OCC_BUDGET = 5;
const SEEDED_VERSION = 2;

interface IHarness {
  useCase: CancelLineUseCase;
  orderRepository: FakeOrderRepository;
  fulfillmentRepository: FakeFulfillmentRepository;
  inventoryGateway: FakeOrderInventoryGateway;
}

const makeHarness = async (quantity = 5, cancelledQuantity = 0): Promise<IHarness> => {
  const order: Order = buildOrderWithLinesFixture(
    ORDER_ID,
    '00000000-0000-4000-a000-000000000002',
    [{ orderLineId: LINE_ID, quantity, cancelledQuantity }],
  );
  const logger = makePinoLoggerMock() as unknown as PinoLogger;
  const orderRepository = new FakeOrderRepository();
  const fulfillmentRepository = new FakeFulfillmentRepository();
  const paymentRepository = new FakePaymentRepository();
  const inventoryGateway = new FakeOrderInventoryGateway();
  await orderRepository.save(order);

  const useCase = new CancelLineUseCase(
    new RollbackFakeTransactionPort([orderRepository]),
    orderRepository,
    fulfillmentRepository,
    paymentRepository,
    inventoryGateway,
    OCC_BUDGET,
    logger,
  );
  return { useCase, orderRepository, fulfillmentRepository, inventoryGateway };
};

const planFulfillment = (
  repo: FakeFulfillmentRepository,
  lineQuantity: number,
): Promise<Fulfillment> =>
  repo.save(
    Fulfillment.create({
      orderId: ORDER_ID,
      stockLocationId: 'default-warehouse',
      lines: [{ orderLineId: LINE_ID, quantity: lineQuantity }],
    }),
  );

const cancelLinePayload = (
  overrides: Partial<IRetailOrderCancelLinePayload> = {},
): IRetailOrderCancelLinePayload => ({
  orderId: ORDER_ID,
  orderLineId: LINE_ID,
  actorId: STAFF_ID,
  isStaffCancel: true,
  correlationId: 'corr-1',
  ...overrides,
});

const readLine = async (repo: FakeOrderRepository): Promise<OrderLine> => {
  const order = await repo.findById(ORDER_ID);
  return order!.lines.find((line) => line.id === LINE_ID)!;
};

describe('CancelLineUseCase', () => {
  it('cancels all the unshipped quantity when none is specified', async () => {
    const h = await makeHarness(5);
    await planFulfillment(h.fulfillmentRepository, 2);

    await h.useCase.execute(cancelLinePayload());

    expect(h.inventoryGateway.cancelCalls).toHaveLength(1);
    expect(h.inventoryGateway.cancelCalls[0]).toMatchObject({
      orderId: ORDER_ID,
      reason: 'line-cancelled',
      lines: [{ variantId: LINE_ID, stockLocationId: 'default-warehouse', quantity: 3 }],
    });
  });

  it('cancels a specified quantity within the unshipped remainder', async () => {
    const h = await makeHarness(5);
    await planFulfillment(h.fulfillmentRepository, 1);

    await h.useCase.execute(cancelLinePayload({ quantity: 2 }));

    expect(h.inventoryGateway.cancelCalls[0].lines[0]).toMatchObject({ quantity: 2 });
  });

  it('rejects a quantity exceeding the unshipped remainder (409)', async () => {
    const h = await makeHarness(5);
    await planFulfillment(h.fulfillmentRepository, 3);

    await expect(h.useCase.execute(cancelLinePayload({ quantity: 3 }))).rejects.toMatchObject({
      code: OrderErrorCodeEnum.FULFILLMENT_QUANTITY_EXCEEDS_REMAINING,
    });
    expect(h.inventoryGateway.cancelCalls).toHaveLength(0);
  });

  it('excludes a cancelled fulfillment from the already-fulfilled remainder', async () => {
    const h = await makeHarness(5);
    const planned = await planFulfillment(h.fulfillmentRepository, 4);
    planned.cancel();
    await h.fulfillmentRepository.save(planned);

    await h.useCase.execute(cancelLinePayload());

    expect(h.inventoryGateway.cancelCalls[0].lines[0]).toMatchObject({ quantity: 5 });
  });

  it('rejects an unknown order line (404)', async () => {
    const h = await makeHarness(5);

    await expect(h.useCase.execute(cancelLinePayload({ orderLineId: 999 }))).rejects.toMatchObject({
      code: OrderErrorCodeEnum.ORDER_LINE_NOT_FOUND,
    });
  });

  it('rejects a non-staff caller (403) — line cancel is staff-only', async () => {
    const h = await makeHarness(5);

    await expect(
      h.useCase.execute(cancelLinePayload({ isStaffCancel: false })),
    ).rejects.toMatchObject({ code: OrderErrorCodeEnum.ORDER_ACCESS_FORBIDDEN });
    expect(h.inventoryGateway.cancelCalls).toHaveLength(0);
  });

  it('rejects an unknown order (404)', async () => {
    const h = await makeHarness(5);

    await expect(h.useCase.execute(cancelLinePayload({ orderId: 999 }))).rejects.toMatchObject({
      code: OrderErrorCodeEnum.ORDER_NOT_FOUND,
    });
  });

  describe('the cancelled quantity is durable (no over-release)', () => {
    it('records the cancelled units on the line and bumps the order version', async () => {
      const h = await makeHarness(5);
      const before = await readLine(h.orderRepository);

      await h.useCase.execute(cancelLinePayload({ quantity: 2 }));

      const after = await readLine(h.orderRepository);
      expect(after.cancelledQuantity).toBe(2);
      expect(after.activeQuantity).toBe(3);
      expect(after.quantity).toBe(5);
      expect(after.lineTotalMinor).toBe(before.lineTotalMinor);

      const order = await h.orderRepository.findById(ORDER_ID);
      expect(order!.version).toBeGreaterThan(SEEDED_VERSION);
    });

    it('refuses to cancel the same units twice, releasing the allocation exactly once', async () => {
      const h = await makeHarness(2);

      await h.useCase.execute(cancelLinePayload({ quantity: 2 }));
      expect(h.inventoryGateway.cancelCalls).toHaveLength(1);

      await expect(h.useCase.execute(cancelLinePayload({ quantity: 2 }))).rejects.toMatchObject({
        code: OrderErrorCodeEnum.FULFILLMENT_QUANTITY_EXCEEDS_REMAINING,
      });

      expect(h.inventoryGateway.cancelCalls).toHaveLength(1);
      expect((await readLine(h.orderRepository)).cancelledQuantity).toBe(2);
    });

    it('accumulates successive partial cancels up to the ordered quantity, then rejects', async () => {
      const h = await makeHarness(3);

      await h.useCase.execute(cancelLinePayload({ quantity: 1 }));
      await h.useCase.execute(cancelLinePayload({ quantity: 1 }));
      expect((await readLine(h.orderRepository)).cancelledQuantity).toBe(2);

      await expect(h.useCase.execute(cancelLinePayload({ quantity: 2 }))).rejects.toMatchObject({
        code: OrderErrorCodeEnum.FULFILLMENT_QUANTITY_EXCEEDS_REMAINING,
      });
      await h.useCase.execute(cancelLinePayload({ quantity: 1 }));

      const line = await readLine(h.orderRepository);
      expect(line.cancelledQuantity).toBe(3);
      expect(line.activeQuantity).toBe(0);
      expect(h.inventoryGateway.cancelCalls).toHaveLength(3);
    });

    it('moves a fully-cancelled line to the terminal cancelled status', async () => {
      const h = await makeHarness(2);

      await h.useCase.execute(cancelLinePayload());

      expect((await readLine(h.orderRepository)).status).toBe(OrderLineStatusEnum.CANCELLED);
    });

    it('measures the cancellable remainder against the already-cancelled units', async () => {
      const h = await makeHarness(4, 1);
      await planFulfillment(h.fulfillmentRepository, 2);

      await expect(h.useCase.execute(cancelLinePayload({ quantity: 2 }))).rejects.toMatchObject({
        code: OrderErrorCodeEnum.FULFILLMENT_QUANTITY_EXCEEDS_REMAINING,
      });

      await h.useCase.execute(cancelLinePayload());
      expect(h.inventoryGateway.cancelCalls[0].lines[0]).toMatchObject({ quantity: 1 });
      expect((await readLine(h.orderRepository)).cancelledQuantity).toBe(2);
    });

    it('does not release the allocation when the write never commits', async () => {
      const h = await makeHarness(5);
      h.orderRepository.conflictsBeforeSuccess = 99;

      await expect(h.useCase.execute(cancelLinePayload({ quantity: 2 }))).rejects.toMatchObject({
        code: OrderErrorCodeEnum.ORDER_VERSION_MISMATCH,
      });

      expect(h.inventoryGateway.cancelCalls).toHaveLength(0);
      expect((await readLine(h.orderRepository)).cancelledQuantity).toBe(0);
    });
  });

  describe('optimistic concurrency', () => {
    it('retries a lost version CAS then cancels exactly once', async () => {
      const h = await makeHarness(5);
      h.orderRepository.conflictsBeforeSuccess = 2;

      await h.useCase.execute(cancelLinePayload({ quantity: 2 }));

      const line = await readLine(h.orderRepository);
      expect(line.cancelledQuantity).toBe(2);
      expect(h.inventoryGateway.cancelCalls).toHaveLength(1);
    });

    it('surfaces 409 VERSION_MISMATCH when the budget is exhausted', async () => {
      const h = await makeHarness(5);
      h.orderRepository.conflictsBeforeSuccess = 99;

      await expect(h.useCase.execute(cancelLinePayload({ quantity: 2 }))).rejects.toMatchObject({
        code: OrderErrorCodeEnum.ORDER_VERSION_MISMATCH,
      });
    });
  });
});
