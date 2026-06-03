import { UnauthorizedException } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';

import { PermissionCodeEnum, RoleEnum } from '@retail-inventory-system/contracts';
import { makePinoLoggerMock, PinoLoggerMock } from '@retail-inventory-system/observability/testing';

import { Customer, RoleAggregate, StaffUser } from '../../../domain';
import { LoginUseCase } from '../login.use-case';
import { RefreshTokenUseCase } from '../refresh-token.use-case';
import {
  FakeAuditLogPublisher,
  FakeHasher,
  FakeTokenAdapter,
  InMemoryCustomerRepository,
  InMemoryStaffUserRepository,
} from './test-doubles';

describe('RefreshTokenUseCase', () => {
  let users: InMemoryStaffUserRepository;
  let customers: InMemoryCustomerRepository;
  let hasher: FakeHasher;
  let tokens: FakeTokenAdapter;
  let loginAudit: FakeAuditLogPublisher;
  let refreshAudit: FakeAuditLogPublisher;
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
    customers = new InMemoryCustomerRepository();
    hasher = new FakeHasher();
    tokens = new FakeTokenAdapter();
    loginAudit = new FakeAuditLogPublisher();
    refreshAudit = new FakeAuditLogPublisher();
    loginLogger = makePinoLoggerMock();
    refreshLogger = makePinoLoggerMock();
    login = new LoginUseCase(
      users,
      hasher,
      tokens,
      loginAudit,
      loginLogger as unknown as PinoLogger,
    );
    refresh = new RefreshTokenUseCase(
      users,
      customers,
      hasher,
      tokens,
      refreshAudit,
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

  it('rotates tokens for a customer subject on the shared /auth/refresh route', async () => {
    const customer = Customer.register('customer-1', {
      email: 'customer-1@example.com',
      passwordHash: await hasher.hash('password123'),
      status: 'active',
    });
    const seededRefresh = await tokens.issueRefreshToken({ sub: customer.id, jti: 'seed-jti' });
    customer.rotateRefreshTokenHash(await hasher.hash(seededRefresh));
    customers.seed(customer);

    const issuedBefore = tokens.issuedAccess.length;
    const rotated = await refresh.execute({ refreshToken: seededRefresh });

    expect(rotated.refreshToken).not.toBe(seededRefresh);
    const reloaded = await customers.findById(customer.id);
    expect(reloaded?.refreshTokenHash).toBe(`hash:${rotated.refreshToken}`);
    // Customer access tokens carry no roles/permissions.
    expect(tokens.issuedAccess[issuedBefore]).toMatchObject({ roles: [], permissions: [] });
  });

  describe('audit-log publishing', () => {
    it('publishes RefreshTokenRotated on the happy path with the staff actor + payload', async () => {
      const user = await seed();
      const first = await login.execute({ email: user.email, password: 'password123' });

      await refresh.execute({ refreshToken: first.refreshToken, correlationId: 'cid-rotate' });

      expect(refreshAudit.published).toHaveLength(1);
      const event = refreshAudit.published[0];
      expect(event).toMatchObject({
        name: 'RefreshTokenRotated',
        actorId: user.id,
        actorKind: 'staff',
        targetId: user.id,
        targetKind: 'staff-user',
        correlationId: 'cid-rotate',
      });
      expect((event.payload as { refreshJti?: string }).refreshJti).toEqual(expect.any(String));
    });

    it('publishes RefreshReuseDetected when a stale refresh token is replayed', async () => {
      const user = await seed();
      const first = await login.execute({ email: user.email, password: 'password123' });
      await refresh.execute({ refreshToken: first.refreshToken });

      await expect(
        refresh.execute({ refreshToken: first.refreshToken, correlationId: 'cid-reuse' }),
      ).rejects.toBeInstanceOf(UnauthorizedException);

      const reuseEvent = refreshAudit.published.find((e) => e.name === 'RefreshReuseDetected');
      expect(reuseEvent).toMatchObject({
        name: 'RefreshReuseDetected',
        actorId: user.id,
        actorKind: 'staff',
        targetId: user.id,
        targetKind: 'staff-user',
        correlationId: 'cid-reuse',
        payload: { reason: 'rotation-reuse' },
      });
    });

    it('publishes RefreshFailed (signature-or-expiry) when verifyRefresh throws', async () => {
      const user = await seed();
      const first = await login.execute({ email: user.email, password: 'password123' });
      tokens.refreshFailures.add(first.refreshToken);

      await expect(
        refresh.execute({ refreshToken: first.refreshToken, correlationId: 'cid-sig' }),
      ).rejects.toBeInstanceOf(UnauthorizedException);

      expect(refreshAudit.published).toHaveLength(1);
      expect(refreshAudit.published[0]).toMatchObject({
        name: 'RefreshFailed',
        actorId: null,
        actorKind: 'anonymous',
        targetId: null,
        targetKind: null,
        correlationId: 'cid-sig',
        payload: { reason: 'signature-or-expiry' },
      });
    });
  });
});
