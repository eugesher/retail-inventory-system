import { ForbiddenException, Inject, Injectable } from '@nestjs/common';

import { ConsentRecordView } from '@retail-inventory-system/contracts';

import { ConsentRecord } from '../../domain';
import { CONSENT_RECORD_REPOSITORY, IConsentRecordRepositoryPort } from '../ports';

export interface IReadConsentQuery {
  customerId: string;
  requesterId: string;
  isStaff: boolean;
}

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
