import { PinoLogger } from 'nestjs-pino';

import { IRetailFulfillmentListPayload } from '@retail-inventory-system/contracts';
import { makePinoLoggerMock } from '@retail-inventory-system/observability/testing';

import { Fulfillment, OrderErrorCodeEnum } from '../../../domain';
import { ListFulfillmentsUseCase } from '../list-fulfillments.use-case';
import {
  buildOrderWithLinesFixture,
  FakeFulfillmentRepository,
  FakeOrderRepository,
} from './test-doubles';

const OWNER_ID = '00000000-0000-4000-a000-000000000002';
const OTHER_ID = '00000000-0000-4000-a000-000000000099';
const ORDER_ID = 1;

interface IHarness {
  useCase: ListFulfillmentsUseCase;
  fulfillmentRepository: FakeFulfillmentRepository;
}

const makeHarness = async (seedFulfillments = 0): Promise<IHarness> => {
  const logger = makePinoLoggerMock() as unknown as PinoLogger;
  const orderRepository = new FakeOrderRepository();
  const fulfillmentRepository = new FakeFulfillmentRepository();

  await orderRepository.save(
    buildOrderWithLinesFixture(ORDER_ID, OWNER_ID, [{ orderLineId: 10, quantity: 5 }]),
  );
  for (let i = 0; i < seedFulfillments; i += 1) {
    await fulfillmentRepository.save(
      Fulfillment.create({
        orderId: ORDER_ID,
        stockLocationId: 'default-warehouse',
        lines: [{ orderLineId: 10, quantity: 1 }],
      }),
    );
  }

  const useCase = new ListFulfillmentsUseCase(orderRepository, fulfillmentRepository, logger);
  return { useCase, fulfillmentRepository };
};

const listPayload = (
  overrides: Partial<IRetailFulfillmentListPayload> = {},
): IRetailFulfillmentListPayload => ({
  orderId: ORDER_ID,
  actorId: OWNER_ID,
  canReadAny: false,
  correlationId: 'corr-1',
  ...overrides,
});

describe('ListFulfillmentsUseCase', () => {
  it('lets the owner list the fulfillments on its own order, newest-first', async () => {
    const { useCase } = await makeHarness(2);

    const views = await useCase.execute(listPayload());

    expect(views).toHaveLength(2);
    // Newest-first: with no `shippedAt` yet, the tiebreak is `id DESC`, so the
    // most-recently-saved fulfillment (the higher id) comes first.
    expect(views[0].id).toBeGreaterThan(views[1].id);
    expect(views.every((view) => view.orderId === ORDER_ID)).toBe(true);
  });

  it('lets staff with order:read (canReadAny) list any order', async () => {
    const { useCase } = await makeHarness(1);

    const views = await useCase.execute(listPayload({ actorId: OTHER_ID, canReadAny: true }));

    expect(views).toHaveLength(1);
  });

  it('returns an empty array for a fulfillment-less order', async () => {
    const { useCase } = await makeHarness(0);

    const views = await useCase.execute(listPayload());

    expect(views).toEqual([]);
  });

  it('rejects a non-owner non-staff caller with ORDER_ACCESS_FORBIDDEN (403)', async () => {
    const { useCase } = await makeHarness(1);

    await expect(
      useCase.execute(listPayload({ actorId: OTHER_ID, canReadAny: false })),
    ).rejects.toMatchObject({ code: OrderErrorCodeEnum.ORDER_ACCESS_FORBIDDEN });
  });

  it('rejects a missing order with ORDER_NOT_FOUND (404)', async () => {
    const { useCase } = await makeHarness(0);

    await expect(useCase.execute(listPayload({ orderId: 999 }))).rejects.toMatchObject({
      code: OrderErrorCodeEnum.ORDER_NOT_FOUND,
    });
  });
});
