import { ConflictException, Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'crypto';

import { AUDIT_LOG_PUBLISHER, IAuditLogPublisher } from '@retail-inventory-system/contracts';

import { Customer } from '../../domain';
import { IRegisterCustomerCommand } from '../dto';
import {
  CUSTOMER_REPOSITORY,
  ICustomerRepositoryPort,
  IPasswordPort,
  PASSWORD_HASHER,
} from '../ports';

@Injectable()
export class RegisterCustomerUseCase {
  constructor(
    @Inject(CUSTOMER_REPOSITORY) private readonly customers: ICustomerRepositoryPort,
    @Inject(PASSWORD_HASHER) private readonly hasher: IPasswordPort,
    @Inject(AUDIT_LOG_PUBLISHER) private readonly audit: IAuditLogPublisher,
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

    const saved = await this.customers.save(customer);

    await this.audit.publish({
      name: 'CustomerRegistered',
      actorId: saved.id,
      actorKind: 'customer',
      targetId: saved.id,
      targetKind: 'customer',
      payload: { email: saved.email },
      correlationId: command.correlationId ?? null,
    });

    return saved;
  }
}
