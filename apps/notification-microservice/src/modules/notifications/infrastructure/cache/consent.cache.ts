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

// Domain-shaped cache-aside over the generic `ICachePort` (ADR-006 / ADR-002): the
// consent-gate depends on `IConsentCachePort` and never sees the cache key string or
// the raw-SQL reader. The cached value is a per-customer `IConsentSnapshot` under the
// `ris:notifications:consent:v1:<customerId>` key shape (ADR-037), kept fresh by the
// `customer.consent.updated` write-through / `customer.erased` eviction consumer — so
// the TTL is only a staleness safety net (ADR-002), not the primary freshness lever.
//
// **Every method is fail-safe** — it warn-logs and swallows a cache/reader error
// rather than throwing, because a caller is an `@EventPattern` dispatch where a thrown
// error would blind-redeliver the event (ADR-011 §7). `get` degrades to the DB reader
// on a cache outage, and to `DEFAULT_CONSENT` if the reader also fails: transactional
// email keeps flowing (default `transactionalEmail = true`) while marketing stays
// suppressed (defaults deny it). The `set`/`del` write-side simply no-ops on error —
// a missed refresh self-heals on the next TTL expiry + reader reload.
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
      // Single-flight the whole get-or-load so a stampede of concurrent dispatches to
      // the same customer collapses to ONE DB read (the StockCache `getOrLoad`
      // precedent, ADR-021). The re-check inside the leader handles a hit landing
      // between the miss and the leader starting.
      return await this.cache.singleFlight(key, async () => {
        const cached = await this.cache.get<IConsentSnapshot>(key);
        if (cached !== undefined) {
          return cached;
        }
        const snapshot = await this.load(customerId);
        await this.trySet(key, snapshot);
        return snapshot;
      });
    } catch (error) {
      // The cache path itself failed (Redis down / single-flight leader threw). Fall
      // back to the reader directly — `load` never throws, so `get` never does either.
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

  // Loads from the DB reader, mapping an absent row (or any reader error) to the
  // defaults. NEVER throws — this is what makes `get` safe to call from an
  // `@EventPattern` consumer.
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

  // Best-effort write-back — a Redis write failure must not discard the freshly-loaded
  // snapshot or break the dispatch, so it warn-logs and swallows (ADR-002). The TTL is
  // in seconds on the env var; `ICachePort.set` takes milliseconds.
  private async trySet(key: string, snapshot: IConsentSnapshot): Promise<void> {
    try {
      await this.cache.set(key, snapshot, this.ttlSeconds * 1000);
    } catch (error) {
      this.logger.warn({ err: error as Error, key }, 'Failed to write consent cache entry');
    }
  }
}
