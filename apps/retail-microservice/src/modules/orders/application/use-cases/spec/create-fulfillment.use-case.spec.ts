import { PinoLogger } from 'nestjs-pino';

import {
  FulfillmentStatusEnum,
  INVENTORY_DEFAULT_STOCK_LOCATION,
  IRetailFulfillmentCreatePayload,
  OrderPaymentStatusEnum,
  OrderStatusEnum,
} from '@retail-inventory-system/contracts';
import { makePinoLoggerMock } from '@retail-inventory-system/observability/testing';

import { Order, OrderErrorCodeEnum } from '../../../domain';
import { CreateFulfillmentUseCase } from '../create-fulfillment.use-case';
import {
  buildOrderWithLinesFixture,
  FakeFulfillmentRepository,
  FakeOrderRepository,
  SpyOrderEventsPublisher,
} from './test-doubles';

const OWNER_ID = '00000000-0000-4000-a000-000000000002';
const STAFF_ID = '00000000-0000-4000-a000-000000000001';
const OTHER_ID = '00000000-0000-4000-a000-000000000099';
const ORDER_ID = 1;

// A two-line order (line 10 ordered 3, line 20 ordered 5), placed-and-authorized and
// owned by OWNER_ID — the default the cross-fulfillment math is measured against.
const TWO_LINE_ORDER = (): Order =>
  buildOrderWithLinesFixture(ORDER_ID, OWNER_ID, [
    { orderLineId: 10, quantity: 3 },
    { orderLineId: 20, quantity: 5 },
  ]);

interface IHarness {
  useCase: CreateFulfillmentUseCase;
  fulfillmentRepository: FakeFulfillmentRepository;
  publisher: SpyOrderEventsPublisher;
}

const makeHarness = async (order: Order = TWO_LINE_ORDER()): Promise<IHarness> => {
  const logger = makePinoLoggerMock() as unknown as PinoLogger;
  const orderRepository = new FakeOrderRepository();
  const fulfillmentRepository = new FakeFulfillmentRepository();
  const publisher = new SpyOrderEventsPublisher();
  await orderRepository.save(order);
  const useCase = new CreateFulfillmentUseCase(
    orderRepository,
    fulfillmentRepository,
    publisher,
    logger,
  );
  return { useCase, fulfillmentRepository, publisher };
};

const createPayload = (
  overrides: Partial<IRetailFulfillmentCreatePayload> = {},
): IRetailFulfillmentCreatePayload => ({
  orderId: ORDER_ID,
  lines: [{ orderLineId: 10, quantity: 2 }],
  actorId: OWNER_ID,
  isStaffFulfill: false,
  correlationId: 'corr-1',
  ...overrides,
});

describe('CreateFulfillmentUseCase', () => {
  it('creates a pending fulfillment and emits retail.fulfillment.created', async () => {
    const { useCase, publisher } = await makeHarness();

    const view = await useCase.execute(createPayload());

    expect(view.id).toBeGreaterThan(0);
    expect(view.orderId).toBe(ORDER_ID);
    expect(view.status).toBe(FulfillmentStatusEnum.PENDING);
    // No `stockLocationId` on the request → defaults to the warehouse.
    expect(view.stockLocationId).toBe(INVENTORY_DEFAULT_STOCK_LOCATION);
    expect(view.trackingNumber).toBeNull();
    expect(view.shippedAt).toBeNull();
    expect(view.lines).toEqual([expect.objectContaining({ orderLineId: 10, quantity: 2 })]);
    // The line came back with a concrete BIGINT id (the saved graph is re-read).
    expect(view.lines[0].id).toBeGreaterThan(0);

    expect(publisher.fulfillmentCreated).toHaveLength(1);
    expect(publisher.fulfillmentCreated[0]).toMatchObject({
      orderId: ORDER_ID,
      fulfillmentId: view.id,
      stockLocationId: INVENTORY_DEFAULT_STOCK_LOCATION,
      lineQuantities: [{ orderLineId: 10, quantity: 2 }],
      eventVersion: 'v1',
    });
  });

  it('honors an explicit stockLocationId', async () => {
    const { useCase } = await makeHarness();

    const view = await useCase.execute(createPayload({ stockLocationId: 'store-front-1' }));

    expect(view.stockLocationId).toBe('store-front-1');
  });

  it('lets staff with order:fulfill (isStaffFulfill) create against any order', async () => {
    const { useCase } = await makeHarness();

    const view = await useCase.execute(createPayload({ actorId: OTHER_ID, isStaffFulfill: true }));

    expect(view.status).toBe(FulfillmentStatusEnum.PENDING);
  });

  it('rejects a non-owner non-staff caller with ORDER_ACCESS_FORBIDDEN (403)', async () => {
    const { useCase } = await makeHarness();

    await expect(
      useCase.execute(createPayload({ actorId: OTHER_ID, isStaffFulfill: false })),
    ).rejects.toMatchObject({ code: OrderErrorCodeEnum.ORDER_ACCESS_FORBIDDEN });
  });

  it('rejects a missing order with ORDER_NOT_FOUND (404)', async () => {
    const { useCase } = await makeHarness();

    await expect(useCase.execute(createPayload({ orderId: 999 }))).rejects.toMatchObject({
      code: OrderErrorCodeEnum.ORDER_NOT_FOUND,
    });
  });

  it('rejects an unknown order line with ORDER_LINE_NOT_FOUND (404)', async () => {
    const { useCase } = await makeHarness();

    await expect(
      useCase.execute(createPayload({ lines: [{ orderLineId: 777, quantity: 1 }] })),
    ).rejects.toMatchObject({ code: OrderErrorCodeEnum.ORDER_LINE_NOT_FOUND });
  });

  it('rejects an over-quantity request with FULFILLMENT_QUANTITY_EXCEEDS_REMAINING (409)', async () => {
    const { useCase } = await makeHarness();

    // Line 10 is ordered 3; requesting 4 exceeds the remaining.
    await expect(
      useCase.execute(createPayload({ lines: [{ orderLineId: 10, quantity: 4 }] })),
    ).rejects.toMatchObject({ code: OrderErrorCodeEnum.FULFILLMENT_QUANTITY_EXCEEDS_REMAINING });
  });

  it('rejects a cancelled order with ORDER_NOT_FULFILLABLE (409)', async () => {
    const { useCase } = await makeHarness(
      buildOrderWithLinesFixture(ORDER_ID, OWNER_ID, [{ orderLineId: 10, quantity: 3 }], {
        status: OrderStatusEnum.CANCELLED,
      }),
    );

    await expect(useCase.execute(createPayload())).rejects.toMatchObject({
      code: OrderErrorCodeEnum.ORDER_NOT_FULFILLABLE,
    });
  });

  it('rejects an order with no authorized payment with ORDER_NOT_FULFILLABLE (409)', async () => {
    const { useCase } = await makeHarness(
      buildOrderWithLinesFixture(ORDER_ID, OWNER_ID, [{ orderLineId: 10, quantity: 3 }], {
        paymentStatus: OrderPaymentStatusEnum.NONE,
      }),
    );

    await expect(useCase.execute(createPayload())).rejects.toMatchObject({
      code: OrderErrorCodeEnum.ORDER_NOT_FULFILLABLE,
    });
  });

  it('counts already-fulfilled quantities across creates (partial-ship math)', async () => {
    const { useCase } = await makeHarness();

    // First shipment: 2 of line 10's 3 ordered units.
    await useCase.execute(createPayload({ lines: [{ orderLineId: 10, quantity: 2 }] }));

    // A second shipment of 2 more would push line 10 to 4 > 3 — the remaining is now 1,
    // not the original 3, proving the already-fulfilled remainder is measured.
    await expect(
      useCase.execute(createPayload({ lines: [{ orderLineId: 10, quantity: 2 }] })),
    ).rejects.toMatchObject({ code: OrderErrorCodeEnum.FULFILLMENT_QUANTITY_EXCEEDS_REMAINING });

    // The exact remaining (1) is still acceptable.
    const second = await useCase.execute(
      createPayload({ lines: [{ orderLineId: 10, quantity: 1 }] }),
    );
    expect(second.lines).toEqual([expect.objectContaining({ orderLineId: 10, quantity: 1 })]);
  });

  it('sums duplicate line entries within one request before the remaining check', async () => {
    const { useCase } = await makeHarness();

    // Line 10 is ordered 3; two entries of 2 sum to 4 > 3 — checked together, not each
    // against the full remainder independently.
    await expect(
      useCase.execute(
        createPayload({
          lines: [
            { orderLineId: 10, quantity: 2 },
            { orderLineId: 10, quantity: 2 },
          ],
        }),
      ),
    ).rejects.toMatchObject({ code: OrderErrorCodeEnum.FULFILLMENT_QUANTITY_EXCEEDS_REMAINING });
  });

  it('rejects an empty-lines request with FULFILLMENT_NO_LINES (the aggregate shape guard)', async () => {
    const { useCase } = await makeHarness();

    await expect(useCase.execute(createPayload({ lines: [] }))).rejects.toMatchObject({
      code: OrderErrorCodeEnum.FULFILLMENT_NO_LINES,
    });
  });

  it('staff can fulfill a confirmed order from a non-default location', async () => {
    const { useCase } = await makeHarness(
      buildOrderWithLinesFixture(ORDER_ID, OWNER_ID, [{ orderLineId: 10, quantity: 3 }], {
        status: OrderStatusEnum.CONFIRMED,
        paymentStatus: OrderPaymentStatusEnum.CAPTURED,
      }),
    );

    const view = await useCase.execute(
      createPayload({ actorId: STAFF_ID, isStaffFulfill: true, stockLocationId: 'dropship-1' }),
    );

    expect(view.status).toBe(FulfillmentStatusEnum.PENDING);
    expect(view.stockLocationId).toBe('dropship-1');
  });
});
