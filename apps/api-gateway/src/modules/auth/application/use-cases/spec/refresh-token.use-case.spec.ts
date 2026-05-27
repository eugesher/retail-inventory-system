import { UnauthorizedException } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';

import { PermissionCodeEnum, RoleEnum } from '@retail-inventory-system/contracts';
import { makePinoLoggerMock, PinoLoggerMock } from '@retail-inventory-system/observability/testing';

import { RoleAggregate } from '../../../domain/role.aggregate';
import { StaffUser } from '../../../domain/staff-user.model';
import { LoginUseCase } from '../login.use-case';
import { RefreshTokenUseCase } from '../refresh-token.use-case';
import { FakeHasher, FakeTokenAdapter, InMemoryStaffUserRepository } from './test-doubles';

describe('RefreshTokenUseCase', () => {
  let users: InMemoryStaffUserRepository;
  let hasher: FakeHasher;
  let tokens: FakeTokenAdapter;
  let loginLogger: PinoLoggerMock;
  let refreshLogger: PinoLoggerMock;
  let login: LoginUseCase;
  let refresh: RefreshTokenUseCase;

  const seed = async (id = 'user-1'): Promise<StaffUser> => {
    const passwordHash = await hasher.hash('password123');
    const user = StaffUser.register(id, {
      email: `${id}@example.com`,
      passwordHash,
      roles: [
        RoleAggregate.create('00000000-0000-4000-c000-000000000001', {
          name: RoleEnum.ADMIN,
          permissions: [PermissionCodeEnum.AUDIT_READ, PermissionCodeEnum.CATALOG_READ],
        }),
      ],
    });
    users.seed(user);
    return user;
  };

  beforeEach(() => {
    users = new InMemoryStaffUserRepository();
    hasher = new FakeHasher();
    tokens = new FakeTokenAdapter();
    loginLogger = makePinoLoggerMock();
    refreshLogger = makePinoLoggerMock();
    login = new LoginUseCase(users, hasher, tokens, loginLogger as unknown as PinoLogger);
    refresh = new RefreshTokenUseCase(
      users,
      hasher,
      tokens,
      refreshLogger as unknown as PinoLogger,
    );
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

  it('re-inflates permissions on the rotated access token', async () => {
    const user = await seed();
    const first = await login.execute({ email: user.email, password: 'password123' });

    const issuedDuringLogin = tokens.issuedAccess.length;
    await refresh.execute({ refreshToken: first.refreshToken });

    const rotatedAccess = tokens.issuedAccess[issuedDuringLogin];
    expect(rotatedAccess.permissions).toEqual(
      [PermissionCodeEnum.AUDIT_READ, PermissionCodeEnum.CATALOG_READ].sort(),
    );
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
