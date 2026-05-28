import { UnauthorizedException } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';

import { makePinoLoggerMock, PinoLoggerMock } from '@retail-inventory-system/observability/testing';

import { Customer } from '../../../domain/customer.model';
import { LoginCustomerUseCase } from '../login-customer.use-case';
import {
  FakeAuditLogPublisher,
  FakeHasher,
  FakeTokenAdapter,
  InMemoryCustomerRepository,
} from './test-doubles';

describe('LoginCustomerUseCase', () => {
  let customers: InMemoryCustomerRepository;
  let hasher: FakeHasher;
  let tokens: FakeTokenAdapter;
  let audit: FakeAuditLogPublisher;
  let logger: PinoLoggerMock;
  let useCase: LoginCustomerUseCase;

  const seedCustomer = async (
    overrides: Partial<{ id: string; email: string; password: string }> = {},
  ): Promise<Customer> => {
    const id = overrides.id ?? 'cust-1';
    const password = overrides.password ?? 'password123';
    const passwordHash = await hasher.hash(password);
    const customer = Customer.register(id, {
      email: overrides.email ?? 'buyer@example.com',
      passwordHash,
      status: 'active',
    });
    customers.seed(customer);
    return customer;
  };

  beforeEach(() => {
    customers = new InMemoryCustomerRepository();
    hasher = new FakeHasher();
    tokens = new FakeTokenAdapter();
    audit = new FakeAuditLogPublisher();
    logger = makePinoLoggerMock();
    useCase = new LoginCustomerUseCase(
      customers,
      hasher,
      tokens,
      audit,
      logger as unknown as PinoLogger,
    );
  });

  it('issues tokens with empty roles + permissions on valid credentials', async () => {
    const customer = await seedCustomer();

    const result = await useCase.execute({ email: customer.email, password: 'password123' });

    expect(result.accessToken).toMatch(/^access:cust-1:/);
    expect(result.refreshToken).toMatch(/^refresh:cust-1:/);
    expect(result.expiresIn).toBe(900);
    expect(result.user).toEqual({
      id: 'cust-1',
      email: 'buyer@example.com',
      roles: [],
      permissions: [],
    });

    const issued = tokens.issuedAccess[0];
    expect(issued.roles).toEqual([]);
    expect(issued.permissions).toEqual([]);

    const reloaded = await customers.findById(customer.id);
    expect(reloaded?.refreshTokenHash).toBe(`hash:${result.refreshToken}`);
  });

  it('rejects with 401 when no customer matches the email', async () => {
    await expect(
      useCase.execute({ email: 'missing@example.com', password: 'password123' }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('rejects with 401 when the password does not match', async () => {
    await seedCustomer();
    await expect(
      useCase.execute({ email: 'buyer@example.com', password: 'WRONG' }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('rejects with 401 when the customer is suspended', async () => {
    const customer = await seedCustomer();
    customer.suspend();
    await expect(
      useCase.execute({ email: customer.email, password: 'password123' }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  describe('audit-log publishing', () => {
    it('publishes CustomerLoggedIn with the customer as actor + target', async () => {
      const customer = await seedCustomer();

      await useCase.execute({
        email: customer.email,
        password: 'password123',
        correlationId: 'cid-c-ok',
      });

      expect(audit.published).toHaveLength(1);
      expect(audit.published[0]).toMatchObject({
        name: 'CustomerLoggedIn',
        actorId: customer.id,
        actorKind: 'customer',
        targetId: customer.id,
        targetKind: 'customer',
        correlationId: 'cid-c-ok',
        payload: { email: customer.email },
      });
    });

    it('publishes CustomerLoginFailed (customer-not-found) with anonymous actor + null target', async () => {
      await expect(
        useCase.execute({
          email: 'nope@example.com',
          password: 'password123',
          correlationId: 'cid-c-miss',
        }),
      ).rejects.toBeInstanceOf(UnauthorizedException);

      expect(audit.published).toHaveLength(1);
      expect(audit.published[0]).toMatchObject({
        name: 'CustomerLoginFailed',
        actorId: null,
        actorKind: 'anonymous',
        targetId: null,
        targetKind: null,
        correlationId: 'cid-c-miss',
        payload: { email: 'nope@example.com', reason: 'customer-not-found' },
      });
    });

    it('publishes CustomerLoginFailed (bad-password) carrying the customer id as target', async () => {
      const customer = await seedCustomer();

      await expect(
        useCase.execute({
          email: customer.email,
          password: 'WRONG',
          correlationId: 'cid-c-bad',
        }),
      ).rejects.toBeInstanceOf(UnauthorizedException);

      expect(audit.published).toHaveLength(1);
      expect(audit.published[0]).toMatchObject({
        name: 'CustomerLoginFailed',
        actorId: null,
        actorKind: 'anonymous',
        targetId: customer.id,
        targetKind: 'customer',
        correlationId: 'cid-c-bad',
        payload: { email: customer.email, reason: 'bad-password' },
      });
    });
  });
});
