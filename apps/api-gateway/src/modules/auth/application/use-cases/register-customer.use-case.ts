import { ConflictException, Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'crypto';

import { Customer } from '../../domain/customer.model';
import { CUSTOMER_REPOSITORY, ICustomerRepositoryPort } from '../ports/customer.repository.port';
import { IPasswordPort, PASSWORD_HASHER } from '../ports/password.port';
import { IRegisterCustomerCommand } from '../dto/register-customer.command';

@Injectable()
export class RegisterCustomerUseCase {
  constructor(
    @Inject(CUSTOMER_REPOSITORY) private readonly customers: ICustomerRepositoryPort,
    @Inject(PASSWORD_HASHER) private readonly hasher: IPasswordPort,
  ) {}

  public async execute(command: IRegisterCustomerCommand): Promise<Customer> {
    const normalizedEmail = command.email.trim().toLowerCase();

    const existing = await this.customers.findByEmail(normalizedEmail);
    if (existing) {
      throw new ConflictException('A customer with that email already exists');
    }

    const passwordHash = await this.hasher.hash(command.password);
    const customer = Customer.register(randomUUID(), {
      email: normalizedEmail,
      passwordHash,
      status: 'active',
      firstName: command.firstName ?? null,
      lastName: command.lastName ?? null,
      phone: command.phone ?? null,
      emailVerifiedAt: null,
    });

    return this.customers.save(customer);
  }
}
