import { ConflictException } from '@nestjs/common';

import { RegisterCustomerUseCase } from '../register-customer.use-case';
import { FakeAuditLogPublisher, FakeHasher, InMemoryCustomerRepository } from './test-doubles';

describe('RegisterCustomerUseCase', () => {
  let customers: InMemoryCustomerRepository;
  let hasher: FakeHasher;
  let audit: FakeAuditLogPublisher;
  let useCase: RegisterCustomerUseCase;

  beforeEach(() => {
    customers = new InMemoryCustomerRepository();
    hasher = new FakeHasher();
    audit = new FakeAuditLogPublisher();
    useCase = new RegisterCustomerUseCase(customers, hasher, audit);
  });

  it('persists an active customer with the resolved fields', async () => {
    const customer = await useCase.execute({
      email: 'Buyer@Example.COM ',
      password: 'buyerpass1',
      firstName: 'Buyer',
      lastName: 'McShop',
    });

    expect(customer.email).toBe('buyer@example.com');
    expect(customer.passwordHash).toBe('hash:buyerpass1');
    expect(customer.status).toBe('active');
    expect(customer.firstName).toBe('Buyer');
    expect(customer.lastName).toBe('McShop');
    expect(customer.emailVerifiedAt).toBeNull();
  });

  it('rejects on a uniqueness conflict (case-insensitive)', async () => {
    await useCase.execute({ email: 'dup@example.com', password: 'password123' });
    await expect(
      useCase.execute({ email: 'DUP@example.com', password: 'password123' }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  describe('audit-log publishing', () => {
    it('publishes CustomerRegistered exactly once with the new customer as actor + target', async () => {
      const customer = await useCase.execute({
        email: 'new-buyer@example.com',
        password: 'pw',
        correlationId: 'cid-reg',
      });

      expect(audit.published).toHaveLength(1);
      expect(audit.published[0]).toMatchObject({
        name: 'CustomerRegistered',
        actorId: customer.id,
        actorKind: 'customer',
        targetId: customer.id,
        targetKind: 'customer',
        correlationId: 'cid-reg',
        payload: { email: 'new-buyer@example.com' },
      });
    });

    it('does not publish on a conflict (no row was created)', async () => {
      await useCase.execute({ email: 'dup2@example.com', password: 'pw' });
      audit.published.length = 0;

      await expect(
        useCase.execute({ email: 'dup2@example.com', password: 'pw' }),
      ).rejects.toBeInstanceOf(ConflictException);

      expect(audit.published).toEqual([]);
    });
  });
});
