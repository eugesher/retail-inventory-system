import { PinoLogger } from 'nestjs-pino';

import { makePinoLoggerMock, PinoLoggerMock } from '@retail-inventory-system/observability/testing';

import { CreateGuestSessionUseCase } from '../create-guest-session.use-case';
import { FakeHasher, FakeTokenAdapter, InMemoryCustomerRepository } from './test-doubles';

describe('CreateGuestSessionUseCase', () => {
  let customers: InMemoryCustomerRepository;
  let hasher: FakeHasher;
  let tokens: FakeTokenAdapter;
  let logger: PinoLoggerMock;
  let useCase: CreateGuestSessionUseCase;

  beforeEach(() => {
    customers = new InMemoryCustomerRepository();
    hasher = new FakeHasher();
    tokens = new FakeTokenAdapter();
    logger = makePinoLoggerMock();
    useCase = new CreateGuestSessionUseCase(
      customers,
      hasher,
      tokens,
      logger as unknown as PinoLogger,
    );
  });

  it('creates a guest customer with a null password and issues a token pair', async () => {
    const result = await useCase.execute('corr-1');

    expect(result.customerId).toEqual(expect.any(String));
    expect(result.accessToken).toMatch(new RegExp(`^access:${result.customerId}:`));
    expect(result.refreshToken).toMatch(new RegExp(`^refresh:${result.customerId}:`));
    expect(result.expiresIn).toBe(900);

    // The persisted row is a guest with no password.
    const persisted = await customers.findById(result.customerId);
    expect(persisted).not.toBeNull();
    expect(persisted?.status).toBe('guest');
    expect(persisted?.passwordHash).toBeNull();
    // The live refresh-token hash is rotated onto the row (like a real login).
    expect(persisted?.refreshTokenHash).toBe(`hash:${result.refreshToken}`);
  });

  it('mints customer-tier claims (empty roles + permissions, sub = guest id)', async () => {
    const result = await useCase.execute();

    const [access] = tokens.issuedAccess;
    expect(access.sub).toBe(result.customerId);
    expect(access.roles).toEqual([]);
    expect(access.permissions).toEqual([]);
  });

  it('mints a distinct guest per call', async () => {
    const first = await useCase.execute();
    const second = await useCase.execute();

    expect(first.customerId).not.toBe(second.customerId);
  });
});
