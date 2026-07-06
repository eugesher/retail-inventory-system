import { ConsentRecord } from '../../../domain';
import { RecordConsentUseCase } from '../record-consent.use-case';
import { FakeCustomerEventsPublisher, InMemoryConsentRecordRepository } from './test-doubles';

describe('RecordConsentUseCase', () => {
  let consents: InMemoryConsentRecordRepository;
  let publisher: FakeCustomerEventsPublisher;
  let useCase: RecordConsentUseCase;

  beforeEach(() => {
    consents = new InMemoryConsentRecordRepository();
    publisher = new FakeCustomerEventsPublisher();
    useCase = new RecordConsentUseCase(consents, publisher);
  });

  it('starts a first-time write from the all-defaults record', async () => {
    const view = await useCase.execute({
      customerId: 'cust-1',
      marketingEmail: true,
      correlationId: 'corr-1',
    });

    expect(consents.saveCount).toBe(1);
    // Only `marketingEmail` was supplied; the other three keep their defaults.
    expect(view).toMatchObject({
      customerId: 'cust-1',
      transactionalEmail: true,
      marketingEmail: true,
      marketingSms: false,
      dataRetentionPolicy: 'default-7-years',
    });
    // The DB stamp gives a first-write row a non-null `updatedAt`.
    expect(view.updatedAt).not.toBeNull();
  });

  it('overlays a partial write onto the existing record (upsert-merge)', async () => {
    consents.seed(
      ConsentRecord.rehydrate('cust-2', {
        transactionalEmail: true,
        marketingEmail: true,
        marketingSms: true,
        dataRetentionPolicy: 'default-7-years',
        updatedAt: new Date('2026-01-01T00:00:00.000Z'),
      }),
    );

    const view = await useCase.execute({
      customerId: 'cust-2',
      marketingEmail: false,
      correlationId: 'corr-2',
    });

    // Only `marketingEmail` flips; `marketingSms` (true) and the rest are untouched.
    expect(view).toMatchObject({
      customerId: 'cust-2',
      transactionalEmail: true,
      marketingEmail: false,
      marketingSms: true,
      dataRetentionPolicy: 'default-7-years',
    });
  });

  it('emits customer.consent.updated with the saved snapshot exactly once', async () => {
    const view = await useCase.execute({
      customerId: 'cust-3',
      transactionalEmail: false,
      marketingSms: true,
      dataRetentionPolicy: 'short-30-days',
      correlationId: 'corr-3',
    });

    expect(publisher.consentUpdated).toHaveLength(1);
    const [emitted] = publisher.consentUpdated;
    expect(emitted.correlationId).toBe('corr-3');
    // The emitted record IS the saved one — its view matches the returned view.
    expect(emitted.record.toView()).toEqual(view);
    expect(emitted.record.transactionalEmail).toBe(false);
    expect(emitted.record.marketingSms).toBe(true);
    expect(emitted.record.dataRetentionPolicy).toBe('short-30-days');
  });
});
