import { PinoLogger } from 'nestjs-pino';

import { ReturnStatusEnum } from '@retail-inventory-system/contracts';
import { makePinoLoggerMock } from '@retail-inventory-system/observability/testing';

import { ListReturnsForOrderUseCase } from '../list-returns.use-case';
import { buildPersistedReturn, FakeReturnRequestRepository } from './test-doubles';

const STAFF_ID = '99999999-9999-4999-8999-999999999999';
const OTHER_CUSTOMER_ID = '22222222-2222-4222-8222-222222222222';
const ORDER_ID = 1;

const makeHarness = (): {
  useCase: ListReturnsForOrderUseCase;
  repository: FakeReturnRequestRepository;
} => {
  const logger = makePinoLoggerMock() as unknown as PinoLogger;
  const repository = new FakeReturnRequestRepository();
  const useCase = new ListReturnsForOrderUseCase(repository, logger);
  return { useCase, repository };
};

describe('ListReturnsForOrderUseCase', () => {
  it('resolves an empty array for an order with no RMAs', async () => {
    const { useCase } = makeHarness();

    const views = await useCase.execute({
      orderId: ORDER_ID,
      actorId: STAFF_ID,
      isStaff: true,
      correlationId: 'corr-list',
    });

    expect(views).toEqual([]);
  });

  // The repository orders by `requested_at DESC, id DESC`; the fixtures share a
  // `requestedAt`, so the id tiebreak is what orders them — newest RMA first.
  it('lists the order’s RMAs newest-first for a staff caller', async () => {
    const { useCase, repository } = makeHarness();
    const first = repository.seed(buildPersistedReturn(ReturnStatusEnum.CLOSED, { id: 7 }));
    const second = repository.seed(buildPersistedReturn(ReturnStatusEnum.REQUESTED, { id: 8 }));

    const views = await useCase.execute({
      orderId: ORDER_ID,
      actorId: STAFF_ID,
      isStaff: true,
      correlationId: 'corr-list',
    });

    expect(views.map((view) => view.id)).toEqual([second.id, first.id]);
    expect(views[0].status).toBe(ReturnStatusEnum.REQUESTED);
  });

  it('scopes the list to the calling customer’s own RMAs', async () => {
    const { useCase, repository } = makeHarness();
    const owned = repository.seed(buildPersistedReturn(ReturnStatusEnum.REQUESTED, { id: 7 }));
    repository.seed(
      buildPersistedReturn(ReturnStatusEnum.REQUESTED, {
        id: 8,
        customerId: OTHER_CUSTOMER_ID,
      }),
    );

    const views = await useCase.execute({
      orderId: ORDER_ID,
      actorId: owned.customerId,
      isStaff: false,
      correlationId: 'corr-list',
    });

    expect(views.map((view) => view.id)).toEqual([owned.id]);
  });

  // A non-owner is filtered down to an empty list rather than refused — the own-only-list
  // posture (the `ListMyOrders` precedent). A 403 here would leak that the order has RMAs.
  it('resolves an empty array (not a 403) for a customer who owns none of the order’s RMAs', async () => {
    const { useCase, repository } = makeHarness();
    repository.seed(buildPersistedReturn(ReturnStatusEnum.REQUESTED, { id: 7 }));

    const views = await useCase.execute({
      orderId: ORDER_ID,
      actorId: OTHER_CUSTOMER_ID,
      isStaff: false,
      correlationId: 'corr-list',
    });

    expect(views).toEqual([]);
  });

  it('excludes RMAs belonging to another order', async () => {
    const { useCase, repository } = makeHarness();
    const onOrder = repository.seed(buildPersistedReturn(ReturnStatusEnum.REQUESTED, { id: 7 }));
    repository.seed(buildPersistedReturn(ReturnStatusEnum.REQUESTED, { id: 8, orderId: 2 }));

    const views = await useCase.execute({
      orderId: ORDER_ID,
      actorId: STAFF_ID,
      isStaff: true,
      correlationId: 'corr-list',
    });

    expect(views.map((view) => view.id)).toEqual([onOrder.id]);
  });
});
