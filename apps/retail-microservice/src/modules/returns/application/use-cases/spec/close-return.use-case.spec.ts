import { PinoLogger } from 'nestjs-pino';

import { IRetailReturnClosePayload, ReturnStatusEnum } from '@retail-inventory-system/contracts';
import { makePinoLoggerMock } from '@retail-inventory-system/observability/testing';

import { ReturnErrorCodeEnum } from '../../../domain';
import { CloseReturnUseCase } from '../close-return.use-case';
import {
  buildPersistedReturn,
  FakeReturnRequestRepository,
  FakeReturnsUnitOfWorkRunner,
  SpyReturnEventsPublisher,
} from './test-doubles';

const STAFF_ID = '99999999-9999-4999-8999-999999999999';

const makeHarness = (): {
  useCase: CloseReturnUseCase;
  repository: FakeReturnRequestRepository;
  publisher: SpyReturnEventsPublisher;
} => {
  const logger = makePinoLoggerMock() as unknown as PinoLogger;
  const repository = new FakeReturnRequestRepository();
  const returnsUow = new FakeReturnsUnitOfWorkRunner(repository);
  const publisher = new SpyReturnEventsPublisher();
  const useCase = new CloseReturnUseCase(repository, returnsUow, publisher, 5, logger);
  return { useCase, repository, publisher };
};

const payload = (rmaId: number): IRetailReturnClosePayload => ({
  rmaId,
  actorId: STAFF_ID,
  correlationId: 'corr-close',
});

describe('CloseReturnUseCase', () => {
  it('walks an inspected RMA → closed, stamps closedAt, and emits the event', async () => {
    const { useCase, repository, publisher } = makeHarness();
    const seeded = repository.seed(buildPersistedReturn(ReturnStatusEnum.INSPECTED));

    const view = await useCase.execute(payload(seeded.id!));

    expect(view.status).toBe(ReturnStatusEnum.CLOSED);
    expect(view.closedAt).not.toBeNull();

    expect(publisher.closed).toHaveLength(1);
    expect(publisher.closed[0]).toMatchObject({
      rmaId: seeded.id,
      rmaNumber: seeded.rmaNumber,
      orderId: seeded.orderId,
      customerId: seeded.customerId,
      closedAt: view.closedAt,
      eventVersion: 'v1',
      correlationId: 'corr-close',
    });
  });

  it('rejects a missing RMA with RETURN_NOT_FOUND (404)', async () => {
    const { useCase, publisher } = makeHarness();

    await expect(useCase.execute(payload(999))).rejects.toMatchObject({
      code: ReturnErrorCodeEnum.RETURN_NOT_FOUND,
    });
    expect(publisher.closed).toHaveLength(0);
  });

  it('rejects closing a not-yet-inspected RMA with RETURN_INVALID_STATUS_TRANSITION (409)', async () => {
    const { useCase, repository, publisher } = makeHarness();
    const seeded = repository.seed(buildPersistedReturn(ReturnStatusEnum.RECEIVED));

    await expect(useCase.execute(payload(seeded.id!))).rejects.toMatchObject({
      code: ReturnErrorCodeEnum.RETURN_INVALID_STATUS_TRANSITION,
    });
    expect(publisher.closed).toHaveLength(0);
  });

  it('rejects re-closing an already-closed RMA with RETURN_INVALID_STATUS_TRANSITION (409)', async () => {
    const { useCase, repository } = makeHarness();
    const seeded = repository.seed(buildPersistedReturn(ReturnStatusEnum.CLOSED));

    await expect(useCase.execute(payload(seeded.id!))).rejects.toMatchObject({
      code: ReturnErrorCodeEnum.RETURN_INVALID_STATUS_TRANSITION,
    });
  });

  it('still closes when publishing retail.return.closed fails', async () => {
    const { useCase, repository, publisher } = makeHarness();
    const seeded = repository.seed(buildPersistedReturn(ReturnStatusEnum.INSPECTED));
    jest.spyOn(publisher, 'publishReturnClosed').mockRejectedValue(new Error('broker down'));

    const view = await useCase.execute(payload(seeded.id!));

    expect(view.status).toBe(ReturnStatusEnum.CLOSED);
    const persisted = await repository.findById(seeded.id!);
    expect(persisted!.status).toBe(ReturnStatusEnum.CLOSED);
  });

  describe('optimistic concurrency', () => {
    it('retries a lost version CAS then closes successfully', async () => {
      const { useCase, repository, publisher } = makeHarness();
      const seeded = repository.seed(buildPersistedReturn(ReturnStatusEnum.INSPECTED));
      repository.conflictsBeforeSuccess = 2;

      const view = await useCase.execute(payload(seeded.id!));

      expect(view.status).toBe(ReturnStatusEnum.CLOSED);
      expect(publisher.closed).toHaveLength(1);
    });

    it('surfaces 409 VERSION_MISMATCH with details.currentVersion when the budget is exhausted', async () => {
      const { useCase, repository, publisher } = makeHarness();
      const seeded = repository.seed(buildPersistedReturn(ReturnStatusEnum.INSPECTED));
      repository.conflictsBeforeSuccess = 99;

      await expect(useCase.execute(payload(seeded.id!))).rejects.toMatchObject({
        code: ReturnErrorCodeEnum.RETURN_VERSION_MISMATCH,
        details: { currentVersion: 1 },
      });
      expect(publisher.closed).toHaveLength(0);
    });
  });
});
