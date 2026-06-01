import { NotFoundException } from '@nestjs/common';

import { Customer } from '../../../domain';
import { GetCurrentCustomerUseCase } from '../get-current-customer.use-case';
import { InMemoryCustomerRepository } from './test-doubles';

describe('GetCurrentCustomerUseCase', () => {
  let customers: InMemoryCustomerRepository;
  let useCase: GetCurrentCustomerUseCase;

  beforeEach(() => {
    customers = new InMemoryCustomerRepository();
    useCase = new GetCurrentCustomerUseCase(customers);
  });

  it('returns the customer when it exists', async () => {
    customers.seed(
      Customer.register('cust-1', {
        email: 'me@example.com',
        passwordHash: 'argon2-hash',
        status: 'active',
      }),
    );

    const customer = await useCase.execute('cust-1');
    expect(customer.id).toBe('cust-1');
    expect(customer.email).toBe('me@example.com');
  });

  it('throws NotFound when the customer is missing', async () => {
    await expect(useCase.execute('cust-missing')).rejects.toBeInstanceOf(NotFoundException);
  });
});
