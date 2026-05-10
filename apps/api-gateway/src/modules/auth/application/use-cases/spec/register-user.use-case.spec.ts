import { ConflictException } from '@nestjs/common';

import { RoleEnum } from '@retail-inventory-system/contracts';

import { RegisterUserUseCase } from '../register-user.use-case';
import { FakeHasher, InMemoryUserRepository } from './test-doubles';

describe('RegisterUserUseCase', () => {
  let users: InMemoryUserRepository;
  let hasher: FakeHasher;
  let useCase: RegisterUserUseCase;

  beforeEach(() => {
    users = new InMemoryUserRepository();
    hasher = new FakeHasher();
    useCase = new RegisterUserUseCase(users, hasher);
  });

  it('persists a new user with the default customer role and a password hash', async () => {
    const user = await useCase.execute({ email: 'New@Example.com ', password: 'password123' });

    expect(user.email).toBe('new@example.com');
    expect(user.passwordHash).toBe('hash:password123');
    expect(user.roles.map((role) => role.value)).toEqual([RoleEnum.CUSTOMER]);
  });

  it('honours an explicit role list', async () => {
    const user = await useCase.execute({
      email: 'admin@example.com',
      password: 'password123',
      roles: [RoleEnum.ADMIN, RoleEnum.CUSTOMER],
    });

    expect(user.roles.map((role) => role.value)).toEqual([RoleEnum.ADMIN, RoleEnum.CUSTOMER]);
  });

  it('rejects on a uniqueness conflict (case-insensitive)', async () => {
    await useCase.execute({ email: 'existing@example.com', password: 'password123' });

    await expect(
      useCase.execute({ email: 'EXISTING@example.com', password: 'password123' }),
    ).rejects.toBeInstanceOf(ConflictException);
  });
});
