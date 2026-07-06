import { ForbiddenException, Inject, Injectable } from '@nestjs/common';

import { ConsentRecordView } from '@retail-inventory-system/contracts';

import { ConsentRecord } from '../../domain';
import { CONSENT_RECORD_REPOSITORY, IConsentRecordRepositoryPort } from '../ports';

// The input to `ReadConsentUseCase`. `customerId` is the record being read;
// `requesterId` is the authenticated principal; `isStaff` is whether that principal
// carries the staff `customer:read-consent` override (computed at the controller).
export interface IReadConsentQuery {
  customerId: string;
  requesterId: string;
  isStaff: boolean;
}

// Read one customer's channel-consent record, **owner-or-staff**. A customer may
// read only their own record (the customer route folds `@CurrentUser().id` into
// both `customerId` and `requesterId`); a staff principal with the
// `customer:read-consent` override may read any (the admin route sets `isStaff`).
// Anyone else (a non-owner without the override) is forbidden — a customer can
// never read another customer's consent.
//
// This use case is deliberately owner-or-staff (not customer-only) so the admin
// consent-read endpoint can reuse it unchanged, passing `isStaff: true`. It is
// therefore **exported** from `auth.module.ts`.
//
// A customer with no stored row resolves to `ConsentRecord.default(customerId)`
// (absent-row-means-defaults), so the read never 404s on a customer who has simply
// never touched their settings.
@Injectable()
export class ReadConsentUseCase {
  constructor(
    @Inject(CONSENT_RECORD_REPOSITORY)
    private readonly consents: IConsentRecordRepositoryPort,
  ) {}

  public async execute(query: IReadConsentQuery): Promise<ConsentRecordView> {
    if (!query.isStaff && query.requesterId !== query.customerId) {
      throw new ForbiddenException('Cannot read another customer’s consent record');
    }

    const record =
      (await this.consents.findByCustomerId(query.customerId)) ??
      ConsentRecord.default(query.customerId);

    return record.toView();
  }
}
