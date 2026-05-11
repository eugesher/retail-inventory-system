import { NotFoundException } from '@nestjs/common';

import { RoleEnum } from '@retail-inventory-system/contracts';

import { RoleVO } from '../../../domain/role.model';
import { User } from '../../../domain/user.model';
import { LogoutUseCase } from '../logout.use-case';
import { FakeHasher, InMemoryUserRepository } from './test-doubles';

describe('LogoutUseCase', () => {
  let users: InMemoryUserRepository;
  let useCase: LogoutUseCase;

  beforeEach(() => {
    users = new InMemoryUserRepository();
    useCase = new LogoutUseCase(users);
  });

  const seedActiveUser = async (): Promise<User> => {
    const passwordHash = await new FakeHasher().hash('password123');
    const user = User.register('user-1', {
      email: 'user@example.com',
      passwordHash,
      roles: [new RoleVO(RoleEnum.CUSTOMER)],
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
