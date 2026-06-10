import { PinoLogger } from 'nestjs-pino';

import { IRetailOrderListPayload } from '@retail-inventory-system/contracts';
import { makePinoLoggerMock } from '@retail-inventory-system/observability/testing';

import { ListMyOrdersUseCase } from '../list-my-orders.use-case';
import { buildOrderFixture, FakeOrderRepository } from './test-doubles';

const CUSTOMER_ID = '00000000-0000-4000-a000-000000000002';
const OTHER_ID = '00000000-0000-4000-a000-000000000099';

const makeUseCase = async (): Promise<ListMyOrdersUseCase> => {
  const logger = makePinoLoggerMock() as unknown as PinoLogger;
  const orderRepository = new FakeOrderRepository();

  // Three orders for our customer (placed at increasing times) + one for someone
  // else. Order 3 is the newest.
  await orderRepository.save(
    buildOrderFixture(1, CUSTOMER_ID, undefined, 1000, new Date('2026-06-01T00:00:00.000Z')),
  );
  await orderRepository.save(
    buildOrderFixture(2, CUSTOMER_ID, undefined, 1000, new Date('2026-06-02T00:00:00.000Z')),
  );
  await orderRepository.save(
    buildOrderFixture(3, CUSTOMER_ID, undefined, 1000, new Date('2026-06-03T00:00:00.000Z')),
  );
  await orderRepository.save(
    buildOrderFixture(4, OTHER_ID, undefined, 1000, new Date('2026-06-04T00:00:00.000Z')),
  );

  return new ListMyOrdersUseCase(orderRepository, logger);
};

const listPayload = (
  overrides: Partial<IRetailOrderListPayload> = {},
): IRetailOrderListPayload => ({
  customerId: CUSTOMER_ID,
  page: 1,
  pageSize: 20,
  correlationId: 'corr-1',
  ...overrides,
});

describe('ListMyOrdersUseCase', () => {
  it('returns only the own orders of the caller, newest-first', async () => {
    const useCase = await makeUseCase();

    const page = await useCase.execute(listPayload());

    expect(page.total).toBe(3);
    expect(page.items.map((order) => order.id)).toEqual([3, 2, 1]);
    // None of the other customer's orders leak in.
    expect(page.items.every((order) => order.customerId === CUSTOMER_ID)).toBe(true);
  });

  it('paginates: page 1 size 2 returns the two newest', async () => {
    const useCase = await makeUseCase();

    const page = await useCase.execute(listPayload({ page: 1, pageSize: 2 }));

    expect(page.total).toBe(3);
    expect(page.page).toBe(1);
    expect(page.size).toBe(2);
    expect(page.items.map((order) => order.id)).toEqual([3, 2]);
  });

  it('clamps a missing/invalid pageSize to the default', async () => {
    const useCase = await makeUseCase();

    const page = await useCase.execute(listPayload({ pageSize: 0 }));

    expect(page.size).toBe(20);
  });
});
