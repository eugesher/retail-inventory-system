import { BadRequestException, ConflictException } from '@nestjs/common';

import { PermissionCodeEnum, RoleEnum } from '@retail-inventory-system/contracts';

import { RoleAggregate } from '../../../domain/role.aggregate';
import { IRoleRepositoryPort } from '../../ports/role.repository.port';
import { RegisterStaffUserUseCase } from '../register-staff-user.use-case';
import { FakeHasher, InMemoryStaffUserRepository } from './test-doubles';

const ADMIN_ROLE_ID = '00000000-0000-4000-c000-000000000001';
const SUPPORT_ROLE_ID = '00000000-0000-4000-c000-000000000004';

class InMemoryRoleRepository implements IRoleRepositoryPort {
  private byName = new Map<string, RoleAggregate>();

  public register(role: RoleAggregate): void {
    this.byName.set(role.name, role);
  }

  public findById(id: string): Promise<RoleAggregate | null> {
    for (const role of this.byName.values()) {
      if (role.id === id) return Promise.resolve(role);
    }
    return Promise.resolve(null);
  }

  public findByName(name: string): Promise<RoleAggregate | null> {
    return Promise.resolve(this.byName.get(name) ?? null);
  }

  public findAllByNames(names: string[]): Promise<RoleAggregate[]> {
    const out: RoleAggregate[] = [];
    for (const name of names) {
      const role = this.byName.get(name);
      if (role) out.push(role);
    }
    return Promise.resolve(out);
  }

  public findAll(): Promise<RoleAggregate[]> {
    return Promise.resolve(Array.from(this.byName.values()));
  }

  public save(role: RoleAggregate): Promise<RoleAggregate> {
    this.register(role);
    return Promise.resolve(role);
  }

  public replacePermissions(
    role: RoleAggregate,
    codes: PermissionCodeEnum[],
  ): Promise<RoleAggregate> {
    const stored = this.byName.get(role.name);
    if (!stored) return Promise.resolve(role);
    for (const code of [...stored.permissions]) {
      stored.removePermission(code);
    }
    for (const code of codes) {
      stored.addPermission(code);
    }
    return Promise.resolve(stored);
  }
}

describe('RegisterStaffUserUseCase', () => {
  let users: InMemoryStaffUserRepository;
  let roles: InMemoryRoleRepository;
  let hasher: FakeHasher;
  let useCase: RegisterStaffUserUseCase;

  beforeEach(() => {
    users = new InMemoryStaffUserRepository();
    roles = new InMemoryRoleRepository();
    hasher = new FakeHasher();

    roles.register(
      RoleAggregate.create(ADMIN_ROLE_ID, {
        name: RoleEnum.ADMIN,
        permissions: [PermissionCodeEnum.AUDIT_READ],
      }),
    );
    roles.register(
      RoleAggregate.create(SUPPORT_ROLE_ID, {
        name: RoleEnum.ORDER_SUPPORT,
        permissions: [PermissionCodeEnum.ORDER_READ],
      }),
    );

    useCase = new RegisterStaffUserUseCase(users, roles, hasher);
  });

  it('persists a new staff user with the resolved roles', async () => {
    const user = await useCase.execute({
      email: 'New@Example.com ',
      password: 'password123',
      roleNames: [RoleEnum.ADMIN],
    });

    expect(user.email).toBe('new@example.com');
    expect(user.passwordHash).toBe('hash:password123');
    expect(user.roles.map((role) => role.name)).toEqual([RoleEnum.ADMIN]);
  });

  it('rejects when no role names are supplied', async () => {
    await expect(
      useCase.execute({ email: 'no-role@example.com', password: 'password123', roleNames: [] }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects on an unknown role name', async () => {
    await expect(
      useCase.execute({
        email: 'ghost@example.com',
        password: 'password123',
        roleNames: ['nonexistent-role'],
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects on a uniqueness conflict (case-insensitive)', async () => {
    await useCase.execute({
      email: 'existing@example.com',
      password: 'password123',
      roleNames: [RoleEnum.ADMIN],
    });

    await expect(
      useCase.execute({
        email: 'EXISTING@example.com',
        password: 'password123',
        roleNames: [RoleEnum.ADMIN],
      }),
    ).rejects.toBeInstanceOf(ConflictException);
  });
});
