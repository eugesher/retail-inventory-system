import { ConflictException } from '@nestjs/common';

import { RegisterCustomerUseCase } from '../register-customer.use-case';
import { FakeHasher, InMemoryCustomerRepository } from './test-doubles';

describe('RegisterCustomerUseCase', () => {
  let customers: InMemoryCustomerRepository;
  let hasher: FakeHasher;
  let useCase: RegisterCustomerUseCase;

  beforeEach(() => {
    customers = new InMemoryCustomerRepository();
    hasher = new FakeHasher();
    useCase = new RegisterCustomerUseCase(customers, hasher);
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
});
