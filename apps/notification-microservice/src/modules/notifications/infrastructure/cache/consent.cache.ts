import { Inject, Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';

import { CACHE_KEYS, CACHE_PORT, ICachePort } from '@retail-inventory-system/cache';

import {
  CONSENT_CACHE_TTL_SECONDS,
  CONSENT_READER,
  DEFAULT_CONSENT,
  IConsentCachePort,
  IConsentReaderPort,
  IConsentSnapshot,
} from '../../application/ports';

@Injectable()
export class ConsentCache implements IConsentCachePort {
  constructor(
    @Inject(CACHE_PORT)
    private readonly cache: ICachePort,
    @Inject(CONSENT_READER)
    private readonly reader: IConsentReaderPort,
    @Inject(CONSENT_CACHE_TTL_SECONDS)
    private readonly ttlSeconds: number,
    @InjectPinoLogger(ConsentCache.name)
    private readonly logger: PinoLogger,
  ) {}

  public async get(customerId: string): Promise<IConsentSnapshot> {
    const key = CACHE_KEYS.notificationsConsent(customerId);

    try {
      const cached = await this.cache.get<IConsentSnapshot>(key);
      if (cached !== undefined) {
        return cached;
      }

      return await this.cache.singleFlight(key, async () => {
        const hit = await this.cache.get<IConsentSnapshot>(key);
        if (hit !== undefined) {
          return hit;
        }
        const snapshot = await this.load(customerId);
        await this.trySet(key, snapshot);
        return snapshot;
      });
    } catch (error) {
      this.logger.warn(
        { err: error as Error, customerId },
        'Consent cache read failed; falling back to the consent reader',
      );
      return this.load(customerId);
    }
  }

  public async set(customerId: string, consent: IConsentSnapshot): Promise<void> {
    const key = CACHE_KEYS.notificationsConsent(customerId);
    await this.trySet(key, consent);
  }

  public async del(customerId: string): Promise<void> {
    const key = CACHE_KEYS.notificationsConsent(customerId);
    try {
      await this.cache.del(key);
    } catch (error) {
      this.logger.warn({ err: error as Error, customerId }, 'Failed to evict consent cache entry');
    }
  }

  private async load(customerId: string): Promise<IConsentSnapshot> {
    try {
      return (await this.reader.load(customerId)) ?? DEFAULT_CONSENT;
    } catch (error) {
      this.logger.warn(
        { err: error as Error, customerId },
        'Consent reader failed; using default consent (transactional allowed, marketing denied)',
      );
      return DEFAULT_CONSENT;
    }
  }

  private async trySet(key: string, snapshot: IConsentSnapshot): Promise<void> {
    try {
      await this.cache.set(key, snapshot, this.ttlSeconds * 1000);
    } catch (error) {
      this.logger.warn({ err: error as Error, key }, 'Failed to write consent cache entry');
    }
  }
}
