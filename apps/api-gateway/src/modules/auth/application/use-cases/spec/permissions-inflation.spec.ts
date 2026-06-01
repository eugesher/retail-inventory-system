import { PinoLogger } from 'nestjs-pino';

import { PermissionCodeEnum, RoleEnum } from '@retail-inventory-system/contracts';
import { makePinoLoggerMock } from '@retail-inventory-system/observability/testing';

import { RoleAggregate, StaffUser } from '../../../domain';
import { LoginUseCase } from '../login.use-case';
import {
  FakeAuditLogPublisher,
  FakeHasher,
  FakeTokenAdapter,
  InMemoryStaffUserRepository,
} from './test-doubles';

describe('Permissions inflation on the access JWT', () => {
  let users: InMemoryStaffUserRepository;
  let hasher: FakeHasher;
  let tokens: FakeTokenAdapter;
  let login: LoginUseCase;

  beforeEach(() => {
    users = new InMemoryStaffUserRepository();
    hasher = new FakeHasher();
    tokens = new FakeTokenAdapter();
    login = new LoginUseCase(
      users,
      hasher,
      tokens,
      new FakeAuditLogPublisher(),
      makePinoLoggerMock() as unknown as PinoLogger,
    );
  });

  it('merges admin + catalog-manager permission sets — distinct codes, sorted ASC, no duplicates', async () => {
    const passwordHash = await hasher.hash('password123');
    const adminRole = RoleAggregate.create('00000000-0000-4000-c000-000000000001', {
      name: RoleEnum.ADMIN,
      permissions: [
        PermissionCodeEnum.AUDIT_READ,
        PermissionCodeEnum.IAM_ASSIGN,
        PermissionCodeEnum.IAM_ROLE_EDIT,
        PermissionCodeEnum.CATALOG_READ,
        PermissionCodeEnum.CATALOG_WRITE,
      ],
    });
    const catalogManagerRole = RoleAggregate.create('00000000-0000-4000-c000-000000000002', {
      name: RoleEnum.CATALOG_MANAGER,
      // Deliberate overlap with admin: CATALOG_READ + CATALOG_WRITE.
      permissions: [
        PermissionCodeEnum.CATALOG_READ,
        PermissionCodeEnum.CATALOG_WRITE,
        PermissionCodeEnum.CATALOG_PUBLISH,
      ],
    });

    const user = StaffUser.register('user-1', {
      email: 'multi-role@example.com',
      passwordHash,
      roles: [adminRole, catalogManagerRole],
    });
    users.seed(user);

    await login.execute({ email: user.email, password: 'password123' });

    const issued = tokens.issuedAccess[0];
    expect(issued.permissions).toBeDefined();

    const expected = [
      PermissionCodeEnum.AUDIT_READ,
      PermissionCodeEnum.CATALOG_PUBLISH,
      PermissionCodeEnum.CATALOG_READ,
      PermissionCodeEnum.CATALOG_WRITE,
      PermissionCodeEnum.IAM_ASSIGN,
      PermissionCodeEnum.IAM_ROLE_EDIT,
    ].sort();

    expect(issued.permissions).toEqual(expected);

    const deduped = new Set(issued.permissions);
    expect(deduped.size).toBe(issued.permissions.length);

    const sorted = [...issued.permissions].sort();
    expect(issued.permissions).toEqual(sorted);
  });

  it('emits an empty permissions array when a role binds no permissions', async () => {
    const passwordHash = await hasher.hash('password123');
    const emptyRole = RoleAggregate.create('00000000-0000-4000-c000-000000000003', {
      name: RoleEnum.ORDER_SUPPORT,
      permissions: [],
    });
    const user = StaffUser.register('user-2', {
      email: 'empty-role@example.com',
      passwordHash,
      roles: [emptyRole],
    });
    users.seed(user);

    await login.execute({ email: user.email, password: 'password123' });

    expect(tokens.issuedAccess[0].permissions).toEqual([]);
  });
});
