import { NotFoundException } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';

import { RoleEnum } from '@retail-inventory-system/contracts';
import { makePinoLoggerMock, PinoLoggerMock } from '@retail-inventory-system/observability/testing';

import { Customer, RoleAggregate, StaffUser } from '../../../domain';
import { LogoutUseCase } from '../logout.use-case';
import {
  FakeAuditLogPublisher,
  FakeHasher,
  InMemoryCustomerRepository,
  InMemoryStaffUserRepository,
} from './test-doubles';

describe('LogoutUseCase', () => {
  let users: InMemoryStaffUserRepository;
  let customers: InMemoryCustomerRepository;
  let audit: FakeAuditLogPublisher;
  let logger: PinoLoggerMock;
  let useCase: LogoutUseCase;

  beforeEach(() => {
    users = new InMemoryStaffUserRepository();
    customers = new InMemoryCustomerRepository();
    audit = new FakeAuditLogPublisher();
    logger = makePinoLoggerMock();
    useCase = new LogoutUseCase(users, customers, audit, logger as unknown as PinoLogger);
  });

  const seedActiveUser = async (): Promise<StaffUser> => {
    const passwordHash = await new FakeHasher().hash('password123');
    const user = StaffUser.register('user-1', {
      email: 'user@example.com',
      passwordHash,
      roles: [
        RoleAggregate.create('00000000-0000-4000-c000-000000000001', { name: RoleEnum.ADMIN }),
      ],
      refreshTokenHash: 'hash:some-token',
    });
    users.seed(user);
    return user;
  };

  it('clears the refresh-token hash so subsequent refreshes fail', async () => {
    const user = await seedActiveUser();
    expect(user.refreshTokenHash).toBe('hash:some-token');

    await useCase.execute({ userId: user.id });

    const reloaded = await users.findById(user.id);
    expect(reloaded?.refreshTokenHash).toBeNull();
  });

  it('throws 404 when the user does not exist', async () => {
    await expect(useCase.execute({ userId: 'missing-id' })).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('clears the refresh-token hash for a customer subject (shared /auth/logout route)', async () => {
    const customer = Customer.register('customer-1', {
      email: 'customer-1@example.com',
      passwordHash: await new FakeHasher().hash('password123'),
      status: 'active',
      refreshTokenHash: 'hash:customer-token',
    });
    customers.seed(customer);

    await useCase.execute({ userId: customer.id });

    const reloaded = await customers.findById(customer.id);
    expect(reloaded?.refreshTokenHash).toBeNull();
  });

  describe('audit-log publishing', () => {
    it('publishes LogoutPerformed exactly once with the staff actor + target', async () => {
      const user = await seedActiveUser();

      await useCase.execute({ userId: user.id, correlationId: 'cid-logout' });

      expect(audit.published).toHaveLength(1);
      expect(audit.published[0]).toMatchObject({
        name: 'LogoutPerformed',
        actorId: user.id,
        actorKind: 'staff',
        targetId: user.id,
        targetKind: 'staff-user',
        correlationId: 'cid-logout',
        payload: {},
      });
    });

    it('does not publish when the user is missing (404 short-circuit)', async () => {
      await expect(useCase.execute({ userId: 'missing-id' })).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(audit.published).toEqual([]);
    });
  });
});
