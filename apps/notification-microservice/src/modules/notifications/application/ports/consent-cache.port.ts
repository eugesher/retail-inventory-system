import { IConsentSnapshot } from './consent-reader.port';

export const CONSENT_CACHE = Symbol('CONSENT_CACHE');

export const CONSENT_CACHE_TTL_SECONDS = Symbol('CONSENT_CACHE_TTL_SECONDS');

export interface IConsentCachePort {
  get(customerId: string): Promise<IConsentSnapshot>;
  set(customerId: string, consent: IConsentSnapshot): Promise<void>;
  del(customerId: string): Promise<void>;
}
