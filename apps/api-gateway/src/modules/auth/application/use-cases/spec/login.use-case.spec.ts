import { UnauthorizedException } from '@nestjs/common';

import { RoleEnum } from '@retail-inventory-system/contracts';

import { RoleVO } from '../../../domain/role.model';
import { User } from '../../../domain/user.model';
import { LoginUseCase } from '../login.use-case';
import { FakeHasher, FakeTokenAdapter, InMemoryUserRepository } from './test-doubles';

describe('LoginUseCase', () => {
  let users: InMemoryUserRepository;
  let hasher: FakeHasher;
  let tokens: FakeTokenAdapter;
  let useCase: LoginUseCase;

  const seedUser = async (
    overrides: Partial<{ id: string; email: string; password: string; roles: RoleEnum[] }> = {},
  ): Promise<User> => {
    const id = overrides.id ?? 'user-1';
    const password = overrides.password ?? 'password123';
    const passwordHash = await hasher.hash(password);
    const user = User.register(id, {
      email: overrides.email ?? 'user@example.com',
      passwordHash,
      roles: (overrides.roles ?? [RoleEnum.CUSTOMER]).map((role) => new RoleVO(role)),
    });
    users.seed(user);
    return user;
  };

  beforeEach(() => {
    users = new InMemoryUserRepository();
    hasher = new FakeHasher();
    tokens = new FakeTokenAdapter();
    useCase = new LoginUseCase(users, hasher, tokens);
  });

  it('issues tokens and stores a refresh-token hash on valid credentials', async () => {
    const user = await seedUser();

    const result = await useCase.execute({ email: user.email, password: 'password123' });

    expect(result.accessToken).toMatch(/^access:user-1:/);
    expect(result.refreshToken).toMatch(/^refresh:user-1:/);
    expect(result.expiresIn).toBe(900);
    expect(result.user).toEqual({
      id: 'user-1',
      email: 'user@example.com',
      roles: [RoleEnum.CUSTOMER],
    });

    const reloaded = await users.findById(user.id);
    expect(reloaded?.refreshTokenHash).toBe(`hash:${result.refreshToken}`);
  });

  it('rejects with 401 when no user matches the email', async () => {
    await expect(
      useCase.execute({ email: 'missing@example.com', password: 'password123' }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('rejects with 401 when the password does not match', async () => {
    await seedUser();
    await expect(
      useCase.execute({ email: 'user@example.com', password: 'WRONG' }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });
});
