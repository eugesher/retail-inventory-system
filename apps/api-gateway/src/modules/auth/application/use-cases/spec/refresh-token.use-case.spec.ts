import { UnauthorizedException } from '@nestjs/common';

import { RoleEnum } from '@retail-inventory-system/contracts';

import { RoleVO } from '../../../domain/role.model';
import { User } from '../../../domain/user.model';
import { LoginUseCase } from '../login.use-case';
import { RefreshTokenUseCase } from '../refresh-token.use-case';
import { FakeHasher, FakeTokenAdapter, InMemoryUserRepository } from './test-doubles';

describe('RefreshTokenUseCase', () => {
  let users: InMemoryUserRepository;
  let hasher: FakeHasher;
  let tokens: FakeTokenAdapter;
  let login: LoginUseCase;
  let refresh: RefreshTokenUseCase;

  const seed = async (id = 'user-1'): Promise<User> => {
    const passwordHash = await hasher.hash('password123');
    const user = User.register(id, {
      email: `${id}@example.com`,
      passwordHash,
      roles: [new RoleVO(RoleEnum.CUSTOMER)],
    });
    users.seed(user);
    return user;
  };

  beforeEach(() => {
    users = new InMemoryUserRepository();
    hasher = new FakeHasher();
    tokens = new FakeTokenAdapter();
    login = new LoginUseCase(users, hasher, tokens);
    refresh = new RefreshTokenUseCase(users, hasher, tokens);
  });

  it('rotates tokens on a valid refresh', async () => {
    const user = await seed();
    const first = await login.execute({ email: user.email, password: 'password123' });

    const rotated = await refresh.execute({ refreshToken: first.refreshToken });

    expect(rotated.refreshToken).not.toBe(first.refreshToken);
    expect(rotated.accessToken).not.toBe(first.accessToken);

    const reloaded = await users.findById(user.id);
    expect(reloaded?.refreshTokenHash).toBe(`hash:${rotated.refreshToken}`);
  });

  it('rejects rotation reuse and clears the stored hash', async () => {
    const user = await seed();
    const first = await login.execute({ email: user.email, password: 'password123' });

    // Rotate once successfully — `first.refreshToken` is now stale.
    await refresh.execute({ refreshToken: first.refreshToken });

    await expect(refresh.execute({ refreshToken: first.refreshToken })).rejects.toBeInstanceOf(
      UnauthorizedException,
    );

    const reloaded = await users.findById(user.id);
    expect(reloaded?.refreshTokenHash).toBeNull();
  });

  it('rejects when verifyRefresh throws (signature/expiry)', async () => {
    const user = await seed();
    const first = await login.execute({ email: user.email, password: 'password123' });

    tokens.refreshFailures.add(first.refreshToken);

    await expect(refresh.execute({ refreshToken: first.refreshToken })).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('rejects when the user has been soft-deleted', async () => {
    const user = await seed();
    const first = await login.execute({ email: user.email, password: 'password123' });

    await users.softDelete(user.id);

    await expect(refresh.execute({ refreshToken: first.refreshToken })).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });
});
