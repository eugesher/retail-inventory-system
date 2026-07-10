import { PinoLogger } from 'nestjs-pino';

import { ReturnStatusEnum } from '@retail-inventory-system/contracts';
import { makePinoLoggerMock } from '@retail-inventory-system/observability/testing';

import { ReturnErrorCodeEnum } from '../../../domain';
import { GetReturnUseCase } from '../get-return.use-case';
import { buildPersistedReturn, FakeReturnRequestRepository } from './test-doubles';

const STAFF_ID = '99999999-9999-4999-8999-999999999999';
const OTHER_CUSTOMER_ID = '22222222-2222-4222-8222-222222222222';

const makeHarness = (): {
  useCase: GetReturnUseCase;
  repository: FakeReturnRequestRepository;
} => {
  const logger = makePinoLoggerMock() as unknown as PinoLogger;
  const repository = new FakeReturnRequestRepository();
  const useCase = new GetReturnUseCase(repository, logger);
  return { useCase, repository };
};

describe('GetReturnUseCase', () => {
  it('resolves the RMA (header + lines) for its owning customer', async () => {
    const { useCase, repository } = makeHarness();
    const seeded = repository.seed(buildPersistedReturn(ReturnStatusEnum.AUTHORIZED));

    const view = await useCase.execute({
      rmaId: seeded.id!,
      actorId: seeded.customerId,
      isStaff: false,
      correlationId: 'corr-get',
    });

    expect(view).toMatchObject({
      id: seeded.id,
      rmaNumber: seeded.rmaNumber,
      orderId: seeded.orderId,
      customerId: seeded.customerId,
      status: ReturnStatusEnum.AUTHORIZED,
    });
    expect(view.lines).toHaveLength(1);
    expect(view.lines[0]).toMatchObject({ orderLineId: 10, quantity: 2 });
    // The three Date columns are serialized to ISO-8601 (null until stamped).
    expect(view.requestedAt).toBe(seeded.requestedAt.toISOString());
    expect(view.closedAt).toBeNull();
  });

  // A staff caller carries the `order:read` override (folded into `isStaff`), so it reaches
  // an RMA it does not own — the staff override layers over the owner-check (ADR-024).
  it('resolves any RMA for a staff caller', async () => {
    const { useCase, repository } = makeHarness();
    const seeded = repository.seed(buildPersistedReturn(ReturnStatusEnum.REQUESTED));

    const view = await useCase.execute({
      rmaId: seeded.id!,
      actorId: STAFF_ID,
      isStaff: true,
      correlationId: 'corr-get',
    });

    expect(view.id).toBe(seeded.id);
  });

  it('rejects a non-owner customer with RETURN_ACCESS_FORBIDDEN (403)', async () => {
    const { useCase, repository } = makeHarness();
    const seeded = repository.seed(buildPersistedReturn(ReturnStatusEnum.REQUESTED));

    await expect(
      useCase.execute({
        rmaId: seeded.id!,
        actorId: OTHER_CUSTOMER_ID,
        isStaff: false,
        correlationId: 'corr-get',
      }),
    ).rejects.toMatchObject({ code: ReturnErrorCodeEnum.RETURN_ACCESS_FORBIDDEN });
  });

  // Not-found precedes the owner-check, so a probe for someone else's RMA id cannot
  // distinguish "missing" from "not yours" by status code alone.
  it('rejects a missing RMA with RETURN_NOT_FOUND (404)', async () => {
    const { useCase } = makeHarness();

    await expect(
      useCase.execute({
        rmaId: 999,
        actorId: STAFF_ID,
        isStaff: true,
        correlationId: 'corr-get',
      }),
    ).rejects.toMatchObject({ code: ReturnErrorCodeEnum.RETURN_NOT_FOUND });
  });
});
