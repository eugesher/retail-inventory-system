import { PinoLogger } from 'nestjs-pino';

import { IRetailRefundListPayload, RefundStatusEnum } from '@retail-inventory-system/contracts';
import { makePinoLoggerMock } from '@retail-inventory-system/observability/testing';

import { OrderErrorCodeEnum } from '../../../domain';
import { ListRefundsForOrderUseCase } from '../list-refunds.use-case';
import {
  buildOrderFixture,
  buildRefundFixture,
  FakeOrderRepository,
  FakeRefundRepository,
} from './test-doubles';

const OWNER_ID = '00000000-0000-4000-a000-000000000002';
const OTHER_ID = '00000000-0000-4000-a000-000000000099';
const STAFF_ID = '00000000-0000-4000-a000-000000000010';
const ORDER_ID = 1;
const PAYMENT_ID = 1;

interface IHarness {
  useCase: ListRefundsForOrderUseCase;
  refundRepository: FakeRefundRepository;
}

const makeHarness = async (seedRefunds = true): Promise<IHarness> => {
  const logger = makePinoLoggerMock() as unknown as PinoLogger;
  const orderRepository = new FakeOrderRepository();
  const refundRepository = new FakeRefundRepository();

  await orderRepository.save(buildOrderFixture(ORDER_ID, OWNER_ID));
  if (seedRefunds) {
    // Two issued refunds for the order — assert the newest-first ordering survives.
    await refundRepository.save(
      buildRefundFixture(1, ORDER_ID, PAYMENT_ID, RefundStatusEnum.ISSUED, 400),
    );
    await refundRepository.save(
      buildRefundFixture(2, ORDER_ID, PAYMENT_ID, RefundStatusEnum.ISSUED, 600),
    );
  }

  const useCase = new ListRefundsForOrderUseCase(orderRepository, refundRepository, logger);
  return { useCase, refundRepository };
};

const listPayload = (
  overrides: Partial<IRetailRefundListPayload> = {},
): IRetailRefundListPayload => ({
  orderId: ORDER_ID,
  actorId: OWNER_ID,
  isStaff: false,
  correlationId: 'corr-1',
  ...overrides,
});

describe('ListRefundsForOrderUseCase', () => {
  it('lists the owner’s order refunds newest-first', async () => {
    const h = await makeHarness();

    const views = await h.useCase.execute(listPayload());

    expect(views).toHaveLength(2);
    // Newest-first by issued_at then id — both share the fixture timestamp, so id 2 leads.
    expect(views[0].id).toBe(2);
    expect(views[1].id).toBe(1);
    expect(views[0].status).toBe(RefundStatusEnum.ISSUED);
  });

  it('lets staff list a non-owner’s order refunds', async () => {
    const h = await makeHarness();

    const views = await h.useCase.execute(listPayload({ actorId: OTHER_ID, isStaff: true }));

    expect(views).toHaveLength(2);
  });

  it('rejects a non-owner non-staff with REFUND_ACCESS_FORBIDDEN (403)', async () => {
    const h = await makeHarness();

    await expect(
      h.useCase.execute(listPayload({ actorId: OTHER_ID, isStaff: false })),
    ).rejects.toMatchObject({ code: OrderErrorCodeEnum.REFUND_ACCESS_FORBIDDEN });
  });

  it('rejects an unknown order with ORDER_NOT_FOUND', async () => {
    const h = await makeHarness();

    await expect(h.useCase.execute(listPayload({ orderId: 999 }))).rejects.toMatchObject({
      code: OrderErrorCodeEnum.ORDER_NOT_FOUND,
    });
  });

  it('returns an empty list for an order with no refunds', async () => {
    const h = await makeHarness(false);

    const views = await h.useCase.execute(listPayload());

    expect(views).toEqual([]);
  });

  it('uses STAFF_ID staff override path the same as any staff caller', async () => {
    const h = await makeHarness();

    const views = await h.useCase.execute(listPayload({ actorId: STAFF_ID, isStaff: true }));

    expect(views).toHaveLength(2);
  });
});
