import { UnauthorizedException } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';

import { PermissionCodeEnum, RoleEnum } from '@retail-inventory-system/contracts';
import { makePinoLoggerMock, PinoLoggerMock } from '@retail-inventory-system/observability/testing';

import { RoleAggregate } from '../../../domain/role.aggregate';
import { StaffUser } from '../../../domain/staff-user.model';
import { LoginUseCase } from '../login.use-case';
import { FakeHasher, FakeTokenAdapter, InMemoryStaffUserRepository } from './test-doubles';

const ADMIN_ROLE_ID = '00000000-0000-4000-c000-000000000001';

const buildAdminRole = (): RoleAggregate =>
  RoleAggregate.create(ADMIN_ROLE_ID, {
    name: RoleEnum.ADMIN,
    permissions: [PermissionCodeEnum.AUDIT_READ],
  });

describe('LoginUseCase', () => {
  let users: InMemoryStaffUserRepository;
  let hasher: FakeHasher;
  let tokens: FakeTokenAdapter;
  let logger: PinoLoggerMock;
  let useCase: LoginUseCase;

  const seedUser = async (
    overrides: Partial<{
      id: string;
      email: string;
      password: string;
      roles: RoleAggregate[];
    }> = {},
  ): Promise<StaffUser> => {
    const id = overrides.id ?? 'user-1';
    const password = overrides.password ?? 'password123';
    const passwordHash = await hasher.hash(password);
    const user = StaffUser.register(id, {
      email: overrides.email ?? 'user@example.com',
      passwordHash,
      roles: overrides.roles ?? [buildAdminRole()],
    });
    users.seed(user);
    return user;
  };

  beforeEach(() => {
    users = new InMemoryStaffUserRepository();
    hasher = new FakeHasher();
    tokens = new FakeTokenAdapter();
    logger = makePinoLoggerMock();
    useCase = new LoginUseCase(users, hasher, tokens, logger as unknown as PinoLogger);
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
      roles: [RoleEnum.ADMIN],
    });

    const reloaded = await users.findById(user.id);
    expect(reloaded?.refreshTokenHash).toBe(`hash:${result.refreshToken}`);
  });

  it('updates lastLoginAt on successful login', async () => {
    const user = await seedUser();
    expect(user.lastLoginAt).toBeNull();

    await useCase.execute({ email: user.email, password: 'password123' });

    const reloaded = await users.findById(user.id);
    expect(reloaded?.lastLoginAt).toBeInstanceOf(Date);
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

  it('rejects with 401 when the user is suspended', async () => {
    const user = await seedUser();
    user.suspend();

    await expect(
      useCase.execute({ email: user.email, password: 'password123' }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });
});
