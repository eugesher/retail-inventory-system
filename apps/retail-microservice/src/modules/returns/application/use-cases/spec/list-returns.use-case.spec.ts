import { PinoLogger } from 'nestjs-pino';

import { ReturnStatusEnum } from '@retail-inventory-system/contracts';
import { makePinoLoggerMock } from '@retail-inventory-system/observability/testing';

import { ReturnErrorCodeEnum } from '../../../domain';
import { ListReturnsForOrderUseCase } from '../list-returns.use-case';
import {
  buildOrderSnapshot,
  buildPersistedReturn,
  FakeReturnOrderReader,
  FakeReturnRequestRepository,
} from './test-doubles';

const STAFF_ID = '99999999-9999-4999-8999-999999999999';
const OTHER_CUSTOMER_ID = '22222222-2222-4222-8222-222222222222';
const ORDER_OWNER_ID = '11111111-1111-4111-8111-111111111111';
const ORDER_ID = 1;

const makeHarness = (
  snapshotOverrides: Parameters<typeof buildOrderSnapshot>[0] = {},
): {
  useCase: ListReturnsForOrderUseCase;
  repository: FakeReturnRequestRepository;
  reader: FakeReturnOrderReader;
} => {
  const logger = makePinoLoggerMock() as unknown as PinoLogger;
  const repository = new FakeReturnRequestRepository();
  const reader = new FakeReturnOrderReader(buildOrderSnapshot(snapshotOverrides));
  const useCase = new ListReturnsForOrderUseCase(
    repository,
    reader,
    logger as unknown as PinoLogger,
  );
  return { useCase, repository, reader };
};

const list = (
  useCase: ListReturnsForOrderUseCase,
  actorId: string,
  isStaff: boolean,
): ReturnType<ListReturnsForOrderUseCase['execute']> =>
  useCase.execute({ orderId: ORDER_ID, actorId, isStaff, correlationId: 'corr-list' });

describe('ListReturnsForOrderUseCase', () => {
  it('resolves an empty array for an order with no RMAs', async () => {
    const { useCase } = makeHarness();

    await expect(list(useCase, STAFF_ID, true)).resolves.toEqual([]);
  });

  // The repository orders by `requested_at DESC, id DESC`; the fixtures share a
  // `requestedAt`, so the id tiebreak is what orders them — newest RMA first.
  it('lists the order’s RMAs newest-first for a staff caller', async () => {
    const { useCase, repository } = makeHarness();
    const first = repository.seed(buildPersistedReturn(ReturnStatusEnum.CLOSED, { id: 7 }));
    const second = repository.seed(buildPersistedReturn(ReturnStatusEnum.REQUESTED, { id: 8 }));

    const views = await list(useCase, STAFF_ID, true);

    expect(views.map((view) => view.id)).toEqual([second.id, first.id]);
    expect(views[0].status).toBe(ReturnStatusEnum.REQUESTED);
  });

  it('lists the order’s RMAs for the buying customer', async () => {
    const { useCase, repository } = makeHarness();
    const owned = repository.seed(buildPersistedReturn(ReturnStatusEnum.REQUESTED, { id: 7 }));

    const views = await list(useCase, ORDER_OWNER_ID, false);

    expect(views.map((view) => view.id)).toEqual([owned.id]);
  });

  // **ADR-051.** This test used to assert the opposite — *"resolves an empty array (not a 403)"* —
  // and that is the point of inverting it rather than deleting it: a removal without a pinned
  // absence is unguarded, and the `.filter()` would come back the next time someone copied this
  // file. Every other ownership check in the system refuses with a 403; this was the one dissenter.
  it('REFUSES a customer who does not own the order (403), rather than filtering to []', async () => {
    const { useCase, repository } = makeHarness();
    repository.seed(buildPersistedReturn(ReturnStatusEnum.REQUESTED, { id: 7 }));

    await expect(list(useCase, OTHER_CUSTOMER_ID, false)).rejects.toMatchObject({
      code: ReturnErrorCodeEnum.RETURN_ACCESS_FORBIDDEN,
    });
  });

  // The subtlety the old shape hid: the owner check runs against the ORDER, not against the RMA
  // rows. Filtering the rows meant an order with **no** RMAs answered `[]` to a non-owner while an
  // order **with** RMAs also answered `[]` — so the endpoint still told a stranger whether the order
  // had returns. Refusing on the order closes that; refusing on the rows would not.
  it('REFUSES a non-owner even when the order has NO RMAs to filter', async () => {
    const { useCase } = makeHarness();

    await expect(list(useCase, OTHER_CUSTOMER_ID, false)).rejects.toMatchObject({
      code: ReturnErrorCodeEnum.RETURN_ACCESS_FORBIDDEN,
    });
  });

  it('404s when the order does not exist', async () => {
    const { useCase, reader } = makeHarness();
    reader.setSnapshot(null);

    await expect(list(useCase, STAFF_ID, true)).rejects.toMatchObject({
      code: ReturnErrorCodeEnum.RETURN_ORDER_NOT_FOUND,
    });
  });

  // A tombstoned buyer leaves `order.customerId` null (ADR-037) — which no `actorId` matches, so an
  // erased order's RMAs become staff-only. That is the intended end state, not an accident.
  it('refuses a customer on an order whose buyer has been erased, but still serves staff', async () => {
    const { useCase, repository } = makeHarness({ customerId: null });
    const rma = repository.seed(buildPersistedReturn(ReturnStatusEnum.REQUESTED, { id: 7 }));

    await expect(list(useCase, ORDER_OWNER_ID, false)).rejects.toMatchObject({
      code: ReturnErrorCodeEnum.RETURN_ACCESS_FORBIDDEN,
    });
    await expect(list(useCase, STAFF_ID, true)).resolves.toEqual([
      expect.objectContaining({ id: rma.id }),
    ]);
  });

  it('excludes RMAs belonging to another order', async () => {
    const { useCase, repository } = makeHarness();
    const onOrder = repository.seed(buildPersistedReturn(ReturnStatusEnum.REQUESTED, { id: 7 }));
    repository.seed(buildPersistedReturn(ReturnStatusEnum.REQUESTED, { id: 8, orderId: 2 }));

    const views = await list(useCase, STAFF_ID, true);

    expect(views.map((view) => view.id)).toEqual([onOrder.id]);
  });
});
