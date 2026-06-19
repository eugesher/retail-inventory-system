import { PinoLogger } from 'nestjs-pino';

import { ReturnStatusEnum } from '@retail-inventory-system/contracts';
import { makePinoLoggerMock } from '@retail-inventory-system/observability/testing';

import { ReturnErrorCodeEnum } from '../../../domain';
import { RejectReturnUseCase } from '../reject-return.use-case';
import {
  buildPersistedReturn,
  FakeReturnRequestRepository,
  SpyReturnEventsPublisher,
} from './test-doubles';

const STAFF_ID = '99999999-9999-4999-8999-999999999999';

const makeHarness = (): {
  useCase: RejectReturnUseCase;
  repository: FakeReturnRequestRepository;
  publisher: SpyReturnEventsPublisher;
} => {
  const logger = makePinoLoggerMock() as unknown as PinoLogger;
  const repository = new FakeReturnRequestRepository();
  const publisher = new SpyReturnEventsPublisher();
  const useCase = new RejectReturnUseCase(repository, publisher, logger);
  return { useCase, repository, publisher };
};

describe('RejectReturnUseCase', () => {
  it('walks a requested RMA → rejected, stamps closedAt, records the reason in notes, and emits the event', async () => {
    const { useCase, repository, publisher } = makeHarness();
    const seeded = repository.seed(buildPersistedReturn(ReturnStatusEnum.REQUESTED));

    const view = await useCase.execute({
      rmaId: seeded.id!,
      reason: 'outside policy',
      actorId: STAFF_ID,
      correlationId: 'corr-reject',
    });

    expect(view.status).toBe(ReturnStatusEnum.REJECTED);
    expect(view.closedAt).not.toBeNull();
    // The rejection reason is appended to notes (no schema change).
    expect(view.notes).toContain('outside policy');

    expect(publisher.rejected).toHaveLength(1);
    expect(publisher.rejected[0]).toMatchObject({
      rmaId: seeded.id,
      reason: 'outside policy',
      eventVersion: 'v1',
      correlationId: 'corr-reject',
    });
  });

  it('rejects a missing RMA with RETURN_NOT_FOUND (404)', async () => {
    const { useCase } = makeHarness();

    await expect(
      useCase.execute({ rmaId: 999, actorId: STAFF_ID, correlationId: 'c' }),
    ).rejects.toMatchObject({ code: ReturnErrorCodeEnum.RETURN_NOT_FOUND });
  });

  it('rejects rejecting an already-authorized RMA with RETURN_INVALID_STATUS_TRANSITION (409)', async () => {
    const { useCase, repository, publisher } = makeHarness();
    const seeded = repository.seed(buildPersistedReturn(ReturnStatusEnum.AUTHORIZED));

    await expect(
      useCase.execute({ rmaId: seeded.id!, actorId: STAFF_ID, correlationId: 'c' }),
    ).rejects.toMatchObject({ code: ReturnErrorCodeEnum.RETURN_INVALID_STATUS_TRANSITION });
    expect(publisher.rejected).toHaveLength(0);
  });
});
