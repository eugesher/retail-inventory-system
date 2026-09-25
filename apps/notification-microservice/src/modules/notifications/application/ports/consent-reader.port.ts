export const CONSENT_READER = Symbol('CONSENT_READER');

export interface IConsentSnapshot {
  transactionalEmail: boolean;
  marketingEmail: boolean;
  marketingSms: boolean;
  dataRetentionPolicy: string;
}

export const DEFAULT_CONSENT: IConsentSnapshot = {
  transactionalEmail: true,
  marketingEmail: false,
  marketingSms: false,
  dataRetentionPolicy: 'default-7-years',
};

export interface IConsentReaderPort {
  load(customerId: string): Promise<IConsentSnapshot | null>;
}
