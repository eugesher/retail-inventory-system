import { ForbiddenException } from '@nestjs/common';

import { ConsentRecord } from '../../../domain';
import { ReadConsentUseCase } from '../read-consent.use-case';
import { InMemoryConsentRecordRepository } from './test-doubles';

describe('ReadConsentUseCase', () => {
  let consents: InMemoryConsentRecordRepository;
  let useCase: ReadConsentUseCase;

  beforeEach(() => {
    consents = new InMemoryConsentRecordRepository();
    useCase = new ReadConsentUseCase(consents);
  });

  it('lets an owner read their own record', async () => {
    consents.seed(
      ConsentRecord.rehydrate('cust-1', {
        transactionalEmail: true,
        marketingEmail: true,
        marketingSms: false,
        dataRetentionPolicy: 'default-7-years',
        updatedAt: new Date('2026-02-02T00:00:00.000Z'),
      }),
    );

    const view = await useCase.execute({
      customerId: 'cust-1',
      requesterId: 'cust-1',
      isStaff: false,
    });

    expect(view).toMatchObject({ customerId: 'cust-1', marketingEmail: true });
  });

  it('lets a staff principal read any customer record', async () => {
    consents.seed(
      ConsentRecord.rehydrate('cust-9', {
        transactionalEmail: true,
        marketingEmail: false,
        marketingSms: true,
        dataRetentionPolicy: 'default-7-years',
        updatedAt: new Date('2026-03-03T00:00:00.000Z'),
      }),
    );

    const view = await useCase.execute({
      customerId: 'cust-9',
      requesterId: 'staff-1',
      isStaff: true,
    });

    expect(view).toMatchObject({ customerId: 'cust-9', marketingSms: true });
  });

  it('forbids a non-owner non-staff requester', async () => {
    await expect(
      useCase.execute({ customerId: 'cust-1', requesterId: 'cust-2', isStaff: false }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('resolves an absent row to the defaults (no 404)', async () => {
    const view = await useCase.execute({
      customerId: 'cust-new',
      requesterId: 'cust-new',
      isStaff: false,
    });

    expect(view).toEqual({
      customerId: 'cust-new',
      transactionalEmail: true,
      marketingEmail: false,
      marketingSms: false,
      dataRetentionPolicy: 'default-7-years',
      updatedAt: null,
    });
  });
});
