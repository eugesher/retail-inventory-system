import { PinoLogger } from 'nestjs-pino';

import { IRetailOrderCancelLinePayload } from '@retail-inventory-system/contracts';
import { makePinoLoggerMock } from '@retail-inventory-system/observability/testing';

import { Fulfillment, Order, OrderErrorCodeEnum } from '../../../domain';
import { CancelLineUseCase } from '../cancel-line.use-case';
import {
  buildOrderWithLinesFixture,
  FakeFulfillmentRepository,
  FakeOrderInventoryGateway,
  FakeOrderRepository,
  FakePaymentRepository,
} from './test-doubles';

const STAFF_ID = '00000000-0000-4000-a000-000000000001';
const ORDER_ID = 1;
const LINE_ID = 10;

interface IHarness {
  useCase: CancelLineUseCase;
  fulfillmentRepository: FakeFulfillmentRepository;
  inventoryGateway: FakeOrderInventoryGateway;
}

// Order line 10 ordered `quantity`; the fixture sets `variantId === orderLineId`, so the
// cancel-allocation line's variant for line 10 is 10.
const makeHarness = async (quantity = 5): Promise<IHarness> => {
  const order: Order = buildOrderWithLinesFixture(
    ORDER_ID,
    '00000000-0000-4000-a000-000000000002',
    [{ orderLineId: LINE_ID, quantity }],
  );
  const logger = makePinoLoggerMock() as unknown as PinoLogger;
  const orderRepository = new FakeOrderRepository();
  const fulfillmentRepository = new FakeFulfillmentRepository();
  const paymentRepository = new FakePaymentRepository();
  const inventoryGateway = new FakeOrderInventoryGateway();
  await orderRepository.save(order);

  const useCase = new CancelLineUseCase(
    orderRepository,
    fulfillmentRepository,
    paymentRepository,
    inventoryGateway,
    logger,
  );
  return { useCase, fulfillmentRepository, inventoryGateway };
};

// Plans (does not ship) a fulfillment slice of the line — a `pending` fulfillment still
// counts toward the already-fulfilled remainder a cancel-line cannot touch.
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

describe('CancelLineUseCase', () => {
  it('cancels all the unshipped quantity when none is specified', async () => {
    const h = await makeHarness(5);
    await planFulfillment(h.fulfillmentRepository, 2); // 2 of 5 already committed

    await h.useCase.execute(cancelLinePayload());

    // Remaining unshipped = 5 − 2 = 3 → the proportional allocation release is for 3.
    expect(h.inventoryGateway.cancelCalls).toHaveLength(1);
    expect(h.inventoryGateway.cancelCalls[0]).toMatchObject({
      orderId: ORDER_ID,
      reason: 'line-cancelled',
      lines: [{ variantId: LINE_ID, stockLocationId: 'default-warehouse', quantity: 3 }],
    });
  });

  it('cancels a specified quantity within the unshipped remainder', async () => {
    const h = await makeHarness(5);
    await planFulfillment(h.fulfillmentRepository, 1); // remaining 4

    await h.useCase.execute(cancelLinePayload({ quantity: 2 }));

    expect(h.inventoryGateway.cancelCalls[0].lines[0]).toMatchObject({ quantity: 2 });
  });

  it('rejects a quantity exceeding the unshipped remainder (409)', async () => {
    const h = await makeHarness(5);
    await planFulfillment(h.fulfillmentRepository, 3); // remaining 2

    await expect(h.useCase.execute(cancelLinePayload({ quantity: 3 }))).rejects.toMatchObject({
      code: OrderErrorCodeEnum.FULFILLMENT_QUANTITY_EXCEEDS_REMAINING,
    });
    expect(h.inventoryGateway.cancelCalls).toHaveLength(0);
  });

  it('excludes a cancelled fulfillment from the already-fulfilled remainder', async () => {
    const h = await makeHarness(5);
    const planned = await planFulfillment(h.fulfillmentRepository, 4);
    // Cancel that fulfillment — its 4 units flow back into the cancellable remainder.
    planned.cancel();
    await h.fulfillmentRepository.save(planned);

    await h.useCase.execute(cancelLinePayload());

    // Remaining unshipped is the full 5 again (the cancelled shipment freed its slice).
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
});
