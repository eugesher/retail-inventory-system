import { UnauthorizedException } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';

import { PermissionCodeEnum, RoleEnum } from '@retail-inventory-system/contracts';
import { makePinoLoggerMock, PinoLoggerMock } from '@retail-inventory-system/observability/testing';

import { RoleAggregate, StaffUser } from '../../../domain';
import { LoginUseCase } from '../login.use-case';
import {
  FakeAuditLogPublisher,
  FakeHasher,
  FakeTokenAdapter,
  InMemoryStaffUserRepository,
} from './test-doubles';

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
  let audit: FakeAuditLogPublisher;
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
    audit = new FakeAuditLogPublisher();
    logger = makePinoLoggerMock();
    useCase = new LoginUseCase(users, hasher, tokens, audit, logger as unknown as PinoLogger);
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
      permissions: [PermissionCodeEnum.AUDIT_READ],
    });

    const issued = tokens.issuedAccess[0];
    expect(issued.permissions).toEqual([PermissionCodeEnum.AUDIT_READ]);

    const reloaded = await users.findById(user.id);
    expect(reloaded?.refreshTokenHash).toBe(`hash:${result.refreshToken}`);
  });

  it('flattens, dedupes, and sorts permissions across multiple roles', async () => {
    const adminRole = RoleAggregate.create('00000000-0000-4000-c000-000000000001', {
      name: RoleEnum.ADMIN,
      permissions: [PermissionCodeEnum.AUDIT_READ, PermissionCodeEnum.CATALOG_READ],
    });
    const catalogManager = RoleAggregate.create('00000000-0000-4000-c000-000000000002', {
      name: RoleEnum.CATALOG_MANAGER,
      permissions: [PermissionCodeEnum.CATALOG_READ, PermissionCodeEnum.CATALOG_WRITE],
    });
    const user = await seedUser({ roles: [adminRole, catalogManager] });

    const result = await useCase.execute({ email: user.email, password: 'password123' });

    const expected = [
      PermissionCodeEnum.AUDIT_READ,
      PermissionCodeEnum.CATALOG_READ,
      PermissionCodeEnum.CATALOG_WRITE,
    ].sort();
    expect(result.user.permissions).toEqual(expected);
    expect(tokens.issuedAccess[0].permissions).toEqual(expected);
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

  describe('audit-log publishing', () => {
    it('publishes UserLoggedIn exactly once on success with the staff actor + payload', async () => {
      const user = await seedUser();

      await useCase.execute({
        email: user.email,
        password: 'password123',
        correlationId: 'cid-success',
      });

      expect(audit.published).toHaveLength(1);
      expect(audit.published[0]).toMatchObject({
        name: 'UserLoggedIn',
        actorId: user.id,
        actorKind: 'staff',
        targetId: user.id,
        targetKind: 'staff-user',
        correlationId: 'cid-success',
        payload: {
          email: user.email,
          roles: [RoleEnum.ADMIN],
          permissions: [PermissionCodeEnum.AUDIT_READ],
        },
      });
    });

    it('publishes LoginFailed (user-not-found) with anonymous actor + null target', async () => {
      await expect(
        useCase.execute({
          email: 'missing@example.com',
          password: 'password123',
          correlationId: 'cid-missing',
        }),
      ).rejects.toBeInstanceOf(UnauthorizedException);

      expect(audit.published).toHaveLength(1);
      expect(audit.published[0]).toMatchObject({
        name: 'LoginFailed',
        actorId: null,
        actorKind: 'anonymous',
        targetId: null,
        targetKind: null,
        correlationId: 'cid-missing',
        payload: { email: 'missing@example.com', reason: 'user-not-found' },
      });
    });

    it('publishes LoginFailed (bad-password) carrying the staff-user id as target', async () => {
      const user = await seedUser();

      await expect(
        useCase.execute({
          email: user.email,
          password: 'WRONG',
          correlationId: 'cid-bad-pw',
        }),
      ).rejects.toBeInstanceOf(UnauthorizedException);

      expect(audit.published).toHaveLength(1);
      expect(audit.published[0]).toMatchObject({
        name: 'LoginFailed',
        actorId: null,
        actorKind: 'anonymous',
        targetId: user.id,
        targetKind: 'staff-user',
        correlationId: 'cid-bad-pw',
        payload: { email: user.email, reason: 'bad-password' },
      });
    });
  });
});
