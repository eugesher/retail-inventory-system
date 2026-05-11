import { UnauthorizedException } from '@nestjs/common';

import { RoleEnum } from '@retail-inventory-system/contracts';

import { RoleVO } from '../../../domain/role.model';
import { User } from '../../../domain/user.model';
import { ValidateUserUseCase } from '../validate-user.use-case';
import { FakeHasher, InMemoryUserRepository } from './test-doubles';

describe('ValidateUserUseCase', () => {
  let users: InMemoryUserRepository;
  let useCase: ValidateUserUseCase;

  beforeEach(() => {
    users = new InMemoryUserRepository();
    useCase = new ValidateUserUseCase(users);
  });

  const payload = {
    sub: 'user-1',
    email: 'user@example.com',
    roles: [RoleEnum.CUSTOMER],
    jti: 'jti-1',
  };

  const seedActiveUser = async (): Promise<void> => {
    const passwordHash = await new FakeHasher().hash('password123');
    const user = User.register('user-1', {
      email: 'user@example.com',
      passwordHash,
      roles: [new RoleVO(RoleEnum.CUSTOMER)],
    });
    users.seed(user);
  };

  it('returns the current user when active', async () => {
    await seedActiveUser();

    const current = await useCase.validate(payload);

    expect(current).toEqual({
      id: 'user-1',
      email: 'user@example.com',
      roles: [RoleEnum.CUSTOMER],
    });
  });

  it('rejects when the user no longer exists', async () => {
    await expect(useCase.validate(payload)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('rejects after soft-delete', async () => {
    await seedActiveUser();
    await users.softDelete('user-1');

    await expect(useCase.validate(payload)).rejects.toBeInstanceOf(UnauthorizedException);
  });
});
