import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';

import { AUDIT_LOG_PUBLISHER, IAuditLogPublisher } from '@retail-inventory-system/contracts';

import { IEraseCustomerCommand } from '../dto';
import {
  CUSTOMER_ERASURE_WRITER,
  CUSTOMER_EVENTS_PUBLISHER,
  CUSTOMER_REPOSITORY,
  ICustomerErasureWriterPort,
  ICustomerEventsPublisherPort,
  ICustomerRepositoryPort,
} from '../ports';

export interface IEraseCustomerResult {
  status: 'deleted';
  erasedAt: string | null;
}

@Injectable()
export class EraseCustomerUseCase {
  constructor(
    @Inject(CUSTOMER_REPOSITORY)
    private readonly customers: ICustomerRepositoryPort,
    @Inject(CUSTOMER_ERASURE_WRITER)
    private readonly writer: ICustomerErasureWriterPort,
    @Inject(AUDIT_LOG_PUBLISHER)
    private readonly audit: IAuditLogPublisher,
    @Inject(CUSTOMER_EVENTS_PUBLISHER)
    private readonly events: ICustomerEventsPublisherPort,
  ) {}

  public async execute(command: IEraseCustomerCommand): Promise<IEraseCustomerResult> {
    const customer = await this.customers.findById(command.customerId);
    if (!customer) {
      throw new NotFoundException(`Customer ${command.customerId} not found`);
    }

    if (customer.status === 'deleted') {
      return {
        status: 'deleted',
        erasedAt: customer.deletedAt?.toISOString() ?? null,
      };
    }

    const confirm = command.confirmEmail.trim().toLowerCase();
    if (customer.email?.toLowerCase() !== confirm) {
      throw new BadRequestException('confirmEmail does not match the customer’s current email');
    }

    const before = { id: customer.id, status: customer.status };

    const erasedAt = new Date();
    customer.erase(erasedAt);
    await this.writer.persistErasure(customer);

    await this.audit.publish({
      name: 'CustomerErased',
      actorId: command.actorStaffUserId,
      actorKind: 'staff',
      targetId: command.customerId,
      targetKind: 'customer',
      payload: { before, after: { status: 'deleted' } },
      correlationId: command.correlationId,
    });

    await this.events.publishErased({
      customerId: command.customerId,
      erasedAt,
      actorStaffUserId: command.actorStaffUserId,
      correlationId: command.correlationId,
    });

    return { status: 'deleted', erasedAt: erasedAt.toISOString() };
  }
}
