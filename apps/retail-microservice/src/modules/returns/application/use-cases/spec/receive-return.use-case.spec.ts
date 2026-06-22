import { PinoLogger } from 'nestjs-pino';

import { IRetailReturnReceivePayload, ReturnStatusEnum } from '@retail-inventory-system/contracts';
import { makePinoLoggerMock } from '@retail-inventory-system/observability/testing';

import { ReturnErrorCodeEnum } from '../../../domain';
import { ReceiveReturnUseCase } from '../receive-return.use-case';
import {
  buildPersistedReturn,
  FAKE_CUSTOMER_EMAIL,
  FakeReturnCustomerContactReader,
  FakeReturnRequestRepository,
  SpyReturnEventsPublisher,
} from './test-doubles';

const WAREHOUSE_ID = '88888888-8888-4888-8888-888888888888';

const makeHarness = (): {
  useCase: ReceiveReturnUseCase;
  repository: FakeReturnRequestRepository;
  publisher: SpyReturnEventsPublisher;
  customerContactReader: FakeReturnCustomerContactReader;
} => {
  const logger = makePinoLoggerMock() as unknown as PinoLogger;
  const repository = new FakeReturnRequestRepository();
  const publisher = new SpyReturnEventsPublisher();
  const customerContactReader = new FakeReturnCustomerContactReader();
  const useCase = new ReceiveReturnUseCase(repository, publisher, customerContactReader, logger);
  return { useCase, repository, publisher, customerContactReader };
};

const payload = (rmaId: number): IRetailReturnReceivePayload => ({
  rmaId,
  actorId: WAREHOUSE_ID,
  correlationId: 'corr-recv',
});

describe('ReceiveReturnUseCase', () => {
  it('walks an authorized RMA → received and emits retail.return.received', async () => {
    const { useCase, repository, publisher, customerContactReader } = makeHarness();
    const seeded = repository.seed(buildPersistedReturn(ReturnStatusEnum.AUTHORIZED));

    const view = await useCase.execute(payload(seeded.id!));

    expect(view.status).toBe(ReturnStatusEnum.RECEIVED);
    expect(view.version).toBe(2); // seeded at version 1, receive bumps to 2

    expect(publisher.received).toHaveLength(1);
    expect(publisher.received[0]).toMatchObject({
      rmaId: seeded.id,
      rmaNumber: seeded.rmaNumber,
      eventVersion: 'v1',
      correlationId: 'corr-recv',
      // The buyer's email was resolved from the RMA's customerId (ADR-033); locale ships null.
      customerEmail: FAKE_CUSTOMER_EMAIL,
      customerLocale: null,
    });
    expect(publisher.received[0].receivedAt).toEqual(expect.any(String));
    expect(customerContactReader.calls).toEqual([seeded.customerId]);
  });

  it('rejects a missing RMA with RETURN_NOT_FOUND (404)', async () => {
    const { useCase } = makeHarness();

    await expect(useCase.execute(payload(999))).rejects.toMatchObject({
      code: ReturnErrorCodeEnum.RETURN_NOT_FOUND,
    });
  });

  it('rejects receiving a still-requested RMA with RETURN_INVALID_STATUS_TRANSITION (409)', async () => {
    const { useCase, repository, publisher } = makeHarness();
    const seeded = repository.seed(buildPersistedReturn(ReturnStatusEnum.REQUESTED));

    await expect(useCase.execute(payload(seeded.id!))).rejects.toMatchObject({
      code: ReturnErrorCodeEnum.RETURN_INVALID_STATUS_TRANSITION,
    });
    expect(publisher.received).toHaveLength(0);
  });
});
