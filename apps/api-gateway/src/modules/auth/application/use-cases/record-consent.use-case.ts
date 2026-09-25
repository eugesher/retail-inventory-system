import { Inject, Injectable } from '@nestjs/common';

import { ConsentRecordView } from '@retail-inventory-system/contracts';

import { ConsentRecord } from '../../domain';
import { IRecordConsentCommand } from '../dto';
import {
  CONSENT_RECORD_REPOSITORY,
  CUSTOMER_EVENTS_PUBLISHER,
  IConsentRecordRepositoryPort,
  ICustomerEventsPublisherPort,
} from '../ports';

@Injectable()
export class RecordConsentUseCase {
  constructor(
    @Inject(CONSENT_RECORD_REPOSITORY)
    private readonly consents: IConsentRecordRepositoryPort,
    @Inject(CUSTOMER_EVENTS_PUBLISHER)
    private readonly publisher: ICustomerEventsPublisherPort,
  ) {}

  public async execute(command: IRecordConsentCommand): Promise<ConsentRecordView> {
    const existing = await this.consents.findByCustomerId(command.customerId);
    const record = existing ?? ConsentRecord.default(command.customerId);

    record.apply({
      transactionalEmail: command.transactionalEmail,
      marketingEmail: command.marketingEmail,
      marketingSms: command.marketingSms,
      dataRetentionPolicy: command.dataRetentionPolicy,
    });

    const saved = await this.consents.save(record);

    await this.publisher.publishConsentUpdated({
      record: saved,
      correlationId: command.correlationId,
    });

    return saved.toView();
  }
}
