import { UnauthorizedException } from '@nestjs/common';

import { RoleEnum } from '@retail-inventory-system/contracts';

import { RoleAggregate } from '../../../domain/role.aggregate';
import { StaffUser } from '../../../domain/staff-user.model';
import { ValidateStaffUserUseCase } from '../validate-staff-user.use-case';
import { FakeHasher, InMemoryStaffUserRepository } from './test-doubles';

describe('ValidateStaffUserUseCase', () => {
  let users: InMemoryStaffUserRepository;
  let useCase: ValidateStaffUserUseCase;

  beforeEach(() => {
    users = new InMemoryStaffUserRepository();
    useCase = new ValidateStaffUserUseCase(users);
  });

  const payload = {
    sub: 'user-1',
    email: 'user@example.com',
    roles: [RoleEnum.ADMIN],
    jti: 'jti-1',
  };

  const seedActiveUser = async (): Promise<StaffUser> => {
    const passwordHash = await new FakeHasher().hash('password123');
    const user = StaffUser.register('user-1', {
      email: 'user@example.com',
      passwordHash,
      roles: [
        RoleAggregate.create('00000000-0000-4000-c000-000000000001', { name: RoleEnum.ADMIN }),
      ],
    });
    users.seed(user);
    return user;
  };

  it('returns the current user when active', async () => {
    await seedActiveUser();

    const current = await useCase.validate(payload);

    expect(current).toEqual({
      id: 'user-1',
      email: 'user@example.com',
      roles: [RoleEnum.ADMIN],
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

  it('rejects when the user is suspended', async () => {
    const user = await seedActiveUser();
    user.suspend();
    // Re-seed because the in-memory repo stores a reference — suspend mutates in-place.
    await expect(useCase.validate(payload)).rejects.toBeInstanceOf(UnauthorizedException);
  });
});
