import { UnauthorizedException } from '@nestjs/common';

import { PermissionCodeEnum, RoleEnum } from '@retail-inventory-system/contracts';

import { Customer, RoleAggregate, StaffUser } from '../../../domain';
import { ValidateJwtSubjectUseCase } from '../validate-jwt-subject.use-case';
import {
  FakeHasher,
  InMemoryCustomerRepository,
  InMemoryStaffUserRepository,
} from './test-doubles';

describe('ValidateJwtSubjectUseCase', () => {
  let staff: InMemoryStaffUserRepository;
  let customers: InMemoryCustomerRepository;
  let useCase: ValidateJwtSubjectUseCase;

  beforeEach(() => {
    staff = new InMemoryStaffUserRepository();
    customers = new InMemoryCustomerRepository();
    useCase = new ValidateJwtSubjectUseCase(staff, customers);
  });

  const staffPayload = {
    sub: 'staff-1',
    email: 'staff@example.com',
    roles: [RoleEnum.ADMIN],
    permissions: [PermissionCodeEnum.AUDIT_READ, PermissionCodeEnum.CATALOG_READ],
    jti: 'jti-1',
  };

  const customerPayload = {
    sub: 'cust-1',
    email: 'buyer@example.com',
    roles: [],
    permissions: [],
    jti: 'jti-2',
  };

  const seedStaff = async (): Promise<StaffUser> => {
    const passwordHash = await new FakeHasher().hash('password123');
    const user = StaffUser.register('staff-1', {
      email: 'staff@example.com',
      passwordHash,
      roles: [
        RoleAggregate.create('00000000-0000-4000-c000-000000000001', { name: RoleEnum.ADMIN }),
      ],
    });
    staff.seed(user);
    return user;
  };

  const seedCustomer = (): Customer => {
    const customer = Customer.register('cust-1', {
      email: 'buyer@example.com',
      passwordHash: 'argon2-hash',
      status: 'active',
    });
    customers.seed(customer);
    return customer;
  };

  it('resolves a staff JWT against the staff repo', async () => {
    await seedStaff();

    const current = await useCase.validate(staffPayload);

    expect(current).toEqual({
      id: 'staff-1',
      email: 'staff@example.com',
      roles: [RoleEnum.ADMIN],
      permissions: [PermissionCodeEnum.AUDIT_READ, PermissionCodeEnum.CATALOG_READ],
    });
  });

  it('falls back to the customer repo on a staff miss', async () => {
    seedCustomer();

    const current = await useCase.validate(customerPayload);

    expect(current).toEqual({
      id: 'cust-1',
      email: 'buyer@example.com',
      roles: [],
      permissions: [],
    });
  });

  it('rejects when both staff and customer repos miss', async () => {
    await expect(useCase.validate(staffPayload)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('rejects after staff soft-delete (and no matching customer)', async () => {
    await seedStaff();
    await staff.softDelete('staff-1');

    await expect(useCase.validate(staffPayload)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('rejects when the customer is suspended', async () => {
    const customer = seedCustomer();
    customer.suspend();

    await expect(useCase.validate(customerPayload)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('defaults permissions to [] when the payload predates this deploy', async () => {
    await seedStaff();

    const legacyPayload = {
      sub: 'staff-1',
      email: 'staff@example.com',
      roles: [RoleEnum.ADMIN],
      jti: 'jti-1',
    } as unknown as Parameters<typeof useCase.validate>[0];

    const current = await useCase.validate(legacyPayload);
    expect(current.permissions).toEqual([]);
  });
});
