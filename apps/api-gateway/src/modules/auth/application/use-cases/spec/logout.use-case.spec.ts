import { NotFoundException } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';

import { RoleEnum } from '@retail-inventory-system/contracts';
import { makePinoLoggerMock, PinoLoggerMock } from '@retail-inventory-system/observability/testing';

import { RoleAggregate } from '../../../domain/role.aggregate';
import { StaffUser } from '../../../domain/staff-user.model';
import { LogoutUseCase } from '../logout.use-case';
import { FakeHasher, InMemoryStaffUserRepository } from './test-doubles';

describe('LogoutUseCase', () => {
  let users: InMemoryStaffUserRepository;
  let logger: PinoLoggerMock;
  let useCase: LogoutUseCase;

  beforeEach(() => {
    users = new InMemoryStaffUserRepository();
    logger = makePinoLoggerMock();
    useCase = new LogoutUseCase(users, logger as unknown as PinoLogger);
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

    await useCase.execute(user.id);

    const reloaded = await users.findById(user.id);
    expect(reloaded?.refreshTokenHash).toBeNull();
  });

  it('throws 404 when the user does not exist', async () => {
    await expect(useCase.execute('missing-id')).rejects.toBeInstanceOf(NotFoundException);
  });
});
