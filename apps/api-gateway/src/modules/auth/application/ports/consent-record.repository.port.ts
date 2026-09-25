import { ConsentRecord } from '../../domain';

export const CONSENT_RECORD_REPOSITORY = Symbol('CONSENT_RECORD_REPOSITORY');

export interface IConsentRecordRepositoryPort {
  findByCustomerId(customerId: string): Promise<ConsentRecord | null>;

  save(record: ConsentRecord): Promise<ConsentRecord>;
}
