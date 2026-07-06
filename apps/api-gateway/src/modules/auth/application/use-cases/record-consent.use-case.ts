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

// Record (upsert) one customer's channel-consent preferences and announce the
// change. The customer id is the authenticated caller's own — the controller folds
// `@CurrentUser().id` into the command, so this use case never writes another
// customer's record (auth + inherent ownership, ADR-024/028; no permission code).
//
// Flow: load the existing row (or start from `ConsentRecord.default(customerId)` —
// absent-row-means-defaults), overlay only the supplied keys (`apply` is an
// upsert-merge), persist, then emit `customer.consent.updated` carrying the FULL
// saved snapshot. The emit is best-effort post-commit — the publisher swallows a
// broker hiccup, so a fan-out failure never fails the committed write.
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
