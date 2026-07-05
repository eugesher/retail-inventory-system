import { BadRequestException, NotFoundException } from '@nestjs/common';

import { Customer } from '../../../domain';
import { EraseCustomerUseCase } from '../erase-customer.use-case';
import {
  FakeAuditLogPublisher,
  FakeCustomerEventsPublisher,
  InMemoryCustomerRepository,
  RecordingCustomerErasureWriter,
} from './test-doubles';

const CUSTOMER_ID = 'cccccccc-cccc-4ccc-accc-cccccccccccc';
const STAFF_ID = 'ssssssss-ssss-4sss-asss-ssssssssssss';

const seedLive = (repo: InMemoryCustomerRepository): void => {
  repo.seed(
    Customer.register(CUSTOMER_ID, {
      email: 'buyer@example.com',
      passwordHash: 'argon2-hash',
      status: 'active',
      phone: '+1-555-0100',
      firstName: 'Buy',
      lastName: 'Er',
      emailVerifiedAt: new Date('2026-01-01T00:00:00.000Z'),
      refreshTokenHash: 'live-token-hash',
    }),
  );
};

describe('EraseCustomerUseCase', () => {
  let customers: InMemoryCustomerRepository;
  let writer: RecordingCustomerErasureWriter;
  let audit: FakeAuditLogPublisher;
  let events: FakeCustomerEventsPublisher;
  let useCase: EraseCustomerUseCase;

  beforeEach(() => {
    customers = new InMemoryCustomerRepository();
    writer = new RecordingCustomerErasureWriter();
    audit = new FakeAuditLogPublisher();
    events = new FakeCustomerEventsPublisher();
    useCase = new EraseCustomerUseCase(customers, writer, audit, events);
  });

  const command = {
    customerId: CUSTOMER_ID,
    confirmEmail: 'buyer@example.com',
    actorStaffUserId: STAFF_ID,
    correlationId: 'corr-1',
  };

  it('runs the full tombstone sequence and returns the tombstone state', async () => {
    seedLive(customers);

    const result = await useCase.execute(command);

    expect(result.status).toBe('deleted');
    expect(result.erasedAt).not.toBeNull();

    // The writer received a customer whose PII is fully nulled.
    expect(writer.persisted).toHaveLength(1);
    const erased = writer.persisted[0];
    expect(erased.status).toBe('deleted');
    expect(erased.email).toBeNull();
    expect(erased.phone).toBeNull();
    expect(erased.firstName).toBeNull();
    expect(erased.lastName).toBeNull();
    expect(erased.passwordHash).toBeNull();
    expect(erased.refreshTokenHash).toBeNull();
    expect(erased.deletedAt).not.toBeNull();
  });

  it('audits the erase with a PII-free before/after', async () => {
    seedLive(customers);

    await useCase.execute(command);

    expect(audit.published).toHaveLength(1);
    const entry = audit.published[0];
    expect(entry.name).toBe('CustomerErased');
    expect(entry.actorId).toBe(STAFF_ID);
    expect(entry.actorKind).toBe('staff');
    expect(entry.targetKind).toBe('customer');
    expect(entry.targetId).toBe(CUSTOMER_ID);
    expect(entry.payload).toEqual({
      before: { id: CUSTOMER_ID, status: 'active' },
      after: { status: 'deleted' },
    });

    // Belt-and-braces: no PII string anywhere in the audit payload.
    const serialized = JSON.stringify(entry.payload);
    expect(serialized).not.toContain('buyer@example.com');
    expect(serialized).not.toContain('Buy');
  });

  it('emits customer.erased with no PII (only ids + erasedAt + actor)', async () => {
    seedLive(customers);

    await useCase.execute(command);

    expect(events.erased).toHaveLength(1);
    const emitted = events.erased[0];
    expect(Object.keys(emitted).sort()).toEqual(
      ['actorStaffUserId', 'correlationId', 'customerId', 'erasedAt'].sort(),
    );
    expect(emitted.customerId).toBe(CUSTOMER_ID);
    expect(emitted.actorStaffUserId).toBe(STAFF_ID);
    expect(emitted.erasedAt).toBeInstanceOf(Date);
  });

  it('audits before it emits (the audit is the compliance record)', async () => {
    seedLive(customers);
    const order: string[] = [];
    jest.spyOn(audit, 'publish').mockImplementation(() => {
      order.push('audit');
      return Promise.resolve();
    });
    jest.spyOn(events, 'publishErased').mockImplementation(() => {
      order.push('emit');
      return Promise.resolve();
    });

    await useCase.execute(command);

    expect(order).toEqual(['audit', 'emit']);
  });

  it('rejects a wrong confirmEmail with 400 and persists / emits nothing', async () => {
    seedLive(customers);

    await expect(
      useCase.execute({ ...command, confirmEmail: 'someone-else@example.com' }),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(writer.persisted).toHaveLength(0);
    expect(audit.published).toHaveLength(0);
    expect(events.erased).toHaveLength(0);
    // The customer is untouched.
    const stillLive = await customers.findById(CUSTOMER_ID);
    expect(stillLive!.status).toBe('active');
    expect(stillLive!.email).toBe('buyer@example.com');
  });

  it('accepts a case-/whitespace-insensitive confirmEmail', async () => {
    seedLive(customers);

    const result = await useCase.execute({ ...command, confirmEmail: '  BUYER@Example.COM  ' });

    expect(result.status).toBe('deleted');
    expect(writer.persisted).toHaveLength(1);
  });

  it('throws 404 when the customer does not exist', async () => {
    await expect(useCase.execute(command)).rejects.toBeInstanceOf(NotFoundException);
    expect(writer.persisted).toHaveLength(0);
  });

  it('short-circuits an already-deleted customer with no second audit/emit/write', async () => {
    const deletedAt = new Date('2026-06-01T00:00:00.000Z');
    customers.seed(
      Customer.rehydrate(CUSTOMER_ID, {
        email: null,
        passwordHash: null,
        status: 'deleted',
        phone: null,
        firstName: null,
        lastName: null,
        emailVerifiedAt: null,
        refreshTokenHash: null,
        deletedAt,
      }),
    );

    const result = await useCase.execute(command);

    expect(result).toEqual({ status: 'deleted', erasedAt: deletedAt.toISOString() });
    expect(writer.persisted).toHaveLength(0);
    expect(audit.published).toHaveLength(0);
    expect(events.erased).toHaveLength(0);
  });
});
