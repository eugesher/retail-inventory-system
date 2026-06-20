import { PinoLogger } from 'nestjs-pino';

import {
  IRetailReturnAuthorizePayload,
  ReturnStatusEnum,
} from '@retail-inventory-system/contracts';
import { makePinoLoggerMock } from '@retail-inventory-system/observability/testing';

import { ReturnErrorCodeEnum } from '../../../domain';
import { AuthorizeReturnUseCase } from '../authorize-return.use-case';
import {
  buildPersistedReturn,
  FakeReturnRequestRepository,
  SpyReturnEventsPublisher,
} from './test-doubles';

const STAFF_ID = '99999999-9999-4999-8999-999999999999';

const makeHarness = (): {
  useCase: AuthorizeReturnUseCase;
  repository: FakeReturnRequestRepository;
  publisher: SpyReturnEventsPublisher;
} => {
  const logger = makePinoLoggerMock() as unknown as PinoLogger;
  const repository = new FakeReturnRequestRepository();
  const publisher = new SpyReturnEventsPublisher();
  const useCase = new AuthorizeReturnUseCase(repository, publisher, logger);
  return { useCase, repository, publisher };
};

const payload = (rmaId: number): IRetailReturnAuthorizePayload => ({
  rmaId,
  actorId: STAFF_ID,
  correlationId: 'corr-auth',
});

describe('AuthorizeReturnUseCase', () => {
  it('walks a requested RMA → authorized and emits retail.return.authorized', async () => {
    const { useCase, repository, publisher } = makeHarness();
    const seeded = repository.seed(buildPersistedReturn(ReturnStatusEnum.REQUESTED));

    const view = await useCase.execute(payload(seeded.id!));

    expect(view.status).toBe(ReturnStatusEnum.AUTHORIZED);
    expect(view.authorizedAt).not.toBeNull();
    expect(view.version).toBe(2); // seeded at version 1, the transition bumps to 2

    expect(publisher.authorized).toHaveLength(1);
    expect(publisher.authorized[0]).toMatchObject({
      rmaId: seeded.id,
      rmaNumber: seeded.rmaNumber,
      orderId: seeded.orderId,
      eventVersion: 'v1',
      correlationId: 'corr-auth',
    });
  });

  it('rejects a missing RMA with RETURN_NOT_FOUND (404)', async () => {
    const { useCase } = makeHarness();

    await expect(useCase.execute(payload(999))).rejects.toMatchObject({
      code: ReturnErrorCodeEnum.RETURN_NOT_FOUND,
    });
  });

  it('rejects authorizing an already-authorized RMA with RETURN_INVALID_STATUS_TRANSITION (409)', async () => {
    const { useCase, repository, publisher } = makeHarness();
    const seeded = repository.seed(buildPersistedReturn(ReturnStatusEnum.AUTHORIZED));

    await expect(useCase.execute(payload(seeded.id!))).rejects.toMatchObject({
      code: ReturnErrorCodeEnum.RETURN_INVALID_STATUS_TRANSITION,
    });
    expect(publisher.authorized).toHaveLength(0);
  });
});
