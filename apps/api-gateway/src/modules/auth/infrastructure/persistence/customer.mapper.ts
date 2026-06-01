import { DeepPartial } from 'typeorm';

import { Customer } from '../../domain/customer.model';
import { CustomerEntity } from './customer.entity';

export class CustomerMapper {
  public static toDomain(entity: CustomerEntity): Customer {
    return Customer.rehydrate(entity.id, {
      email: entity.email,
      passwordHash: entity.passwordHash,
      status: entity.status,
      phone: entity.phone,
      firstName: entity.firstName,
      lastName: entity.lastName,
      emailVerifiedAt: entity.emailVerifiedAt,
      refreshTokenHash: entity.refreshTokenHash,
      createdAt: entity.createdAt,
      updatedAt: entity.updatedAt,
    });
  }

  public static toEntity(customer: Customer): DeepPartial<CustomerEntity> {
    return {
      id: customer.id,
      email: customer.email,
      passwordHash: customer.passwordHash,
      status: customer.status,
      phone: customer.phone,
      firstName: customer.firstName,
      lastName: customer.lastName,
      emailVerifiedAt: customer.emailVerifiedAt,
      refreshTokenHash: customer.refreshTokenHash,
    };
  }
}
