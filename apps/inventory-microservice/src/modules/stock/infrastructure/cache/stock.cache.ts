import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';

import { CACHE_KEYS, CACHE_PORT, ICachePort } from '@retail-inventory-system/cache';
import { VariantStockView } from '@retail-inventory-system/contracts';

import {
  IStockCacheGetPayload,
  IStockCacheGetResult,
  IStockCacheInvalidateItem,
  IStockCachePort,
  IStockCacheSetPayload,
  IStockWithInvalidationOptions,
} from '../../application/ports';

// The domain-shaped cache over the generic `ICachePort`. Use cases depend on `IStockCachePort` and
// never see a key string, so a stock key cannot be built anywhere but here.
//
// **The port offers only `getOrLoad` and `withInvalidation` — the composed operations** (ADR-049).
// There is no public `get`, `set` or `invalidate`, and that is the whole design: each of those,
// called on its own from inside a transaction, writes or clears pre-commit data and leaves the
// cache permanently wrong. The two survivors are the shapes that cannot be misused.
@Injectable()
export class StockCache implements IStockCachePort {
  // ±10% TTL jitter, so a burst of entries written together does not expire together and stampede
  // the database in one tick (ADR-021).
  private static readonly JITTER_FRACTION = 0.1;

  constructor(
    @Inject(CACHE_PORT)
    private readonly cache: ICachePort,
    private readonly configService: ConfigService,
    @InjectPinoLogger(StockCache.name)
    private readonly logger: PinoLogger,
  ) {}

  // ADR-049: private, for the same reason `invalidatePrefixes` is (ADR-023). A public
  // `set` writes an arbitrary value under the stock key at an arbitrary time — including
  // from inside a transaction, with pre-commit data, which is the exact permanent staleness
  // removing public `invalidate` was meant to make unexpressible. `getOrLoad` is the only
  // legitimate caller of the pair, and it is right here.
  private async get(payload: IStockCacheGetPayload): Promise<IStockCacheGetResult> {
    const { variantId, stockLocationIds, tenantId, correlationId } = payload;
    const cacheKey = CACHE_KEYS.inventoryStock(variantId, stockLocationIds, { tenantId });

    try {
      const cached = await this.cache.get<VariantStockView>(cacheKey);
      const cacheHit = cached !== undefined;

      this.logger.debug(
        { correlationId, variantId, cacheKey, cacheHit },
        cacheHit ? 'Cache hit for stock query' : 'Cache miss for stock query',
      );

      return { value: cached, available: true };
    } catch (error) {
      this.logger.warn(
        { err: error as Error, correlationId, variantId, cacheKey },
        'Failed to read from cache',
      );
      return { value: undefined, available: false };
    }
  }

  private async set(payload: IStockCacheSetPayload): Promise<void> {
    const { variantId, stockLocationIds, tenantId, data, correlationId } = payload;
    const cacheKey = CACHE_KEYS.inventoryStock(variantId, stockLocationIds, { tenantId });
    const ttl = this.jitterTtl(this.configuredTtl());

    try {
      await this.cache.set(cacheKey, data, ttl);
      this.logger.debug({ correlationId, variantId, cacheKey, ttl }, 'Cache write for stock query');
    } catch (error) {
      this.logger.warn(
        { err: error as Error, correlationId, variantId, cacheKey },
        'Failed to write to cache',
      );
    }
  }

  public async getOrLoad(
    payload: IStockCacheGetPayload,
    loader: () => Promise<VariantStockView>,
  ): Promise<VariantStockView> {
    const { variantId, stockLocationIds, tenantId, correlationId } = payload;
    const cacheKey = CACHE_KEYS.inventoryStock(variantId, stockLocationIds, { tenantId });

    const { value, available } = await this.get(payload);
    if (value !== undefined) return value;

    // **`available: false` means Redis is down, not that the key was missing.** Go straight to the
    // loader: single-flighting through a dead client would only queue callers behind a lock nobody
    // can take, and each attempt would warn again. A cache outage must degrade to a slow read, never
    // to a stalled one.
    if (!available) return loader();

    // The re-check inside the leader catches the narrow race where another writer's value lands
    // between the outer read and the leader starting.
    return this.cache.singleFlight(cacheKey, async () => {
      const insideLeader = await this.get(payload);
      if (insideLeader.value !== undefined) return insideLeader.value;

      const data = await loader();
      // The inner read may see an outage the outer one missed — skip the write-back rather than warn
      // twice about the same dead client.
      if (insideLeader.available) {
        await this.set({ variantId, stockLocationIds, tenantId, data, correlationId });
      }
      return data;
    });
  }

  private configuredTtl(): number {
    // **The env var is named for a product and governs a variant.** `CACHE_TTL_MS_PRODUCT_STOCK`
    // predates the move to variant-keyed stock and was kept rather than re-named; do not go looking
    // for a variant-named one. The `?? 60000` is not redundant with the Joi default — some unit-test
    // bootstraps skip env loading entirely.
    return this.configService.get<number>('CACHE_TTL_MS_PRODUCT_STOCK') ?? 60000;
  }

  private jitterTtl(ttl: number): number {
    // **Clamped to ≥ 1 ms, and that clamp is load-bearing:** keyv reads a non-positive TTL as
    // "no expiry". A small configured TTL plus a negative jitter would floor to zero and produce an
    // entry that never expires — the exact opposite of what the TTL is for.
    const offset = (Math.random() * 2 - 1) * StockCache.JITTER_FRACTION * ttl;
    return Math.max(1, Math.floor(ttl + offset));
  }

  // ADR-023: the prefix delete is intentionally private. The post-commit
  // ordering is encoded in this method's body (work first, then invalidate)
  // so it cannot be misused from inside a transaction callback.
  public async withInvalidation<T>(
    work: () => Promise<T>,
    resolveItems: (result: T) => IStockCacheInvalidateItem[],
    opts?: IStockWithInvalidationOptions,
  ): Promise<T> {
    const result = await work();
    const items = resolveItems(result);
    if (items.length > 0) {
      await this.invalidatePrefixes(items, opts);
    }
    return result;
  }

  private async invalidatePrefixes(
    items: IStockCacheInvalidateItem[],
    opts?: IStockWithInvalidationOptions,
  ): Promise<void> {
    const { tenantId, correlationId } = opts ?? {};
    const variantIds = [...new Set(items.map((i) => i.variantId))];

    // **Five prefixes per variant, and therefore five Redis SCAN passes on every stock write.**
    // One is the live `v3` key; the other four are retired shapes (`v2`, `v1`, the unversioned
    // pre-v1, and the pre-ADR-016 `stock:<productId>:` convention), wiped so a rolling deploy
    // cannot serve entries the previous version wrote.
    //
    // The cost is real and the transition windows are not: no deploy has ever straddled these key
    // versions, and `cache-keys.ts` records that no production data exists under any of them. This
    // is a known finding, not an oversight — see the legacy builders in `libs/cache/cache-keys.ts`.
    let totalUnlinked = 0;
    try {
      const counts = await Promise.all(
        variantIds.flatMap((variantId) => [
          this.cache.delByPrefix(CACHE_KEYS.inventoryStockPrefix(variantId, { tenantId })),
          this.cache.delByPrefix(CACHE_KEYS.inventoryStockLegacyPrefixV2(variantId)),
          this.cache.delByPrefix(CACHE_KEYS.inventoryStockLegacyPrefixV1(variantId)),
          this.cache.delByPrefix(CACHE_KEYS.inventoryStockLegacyPrefix(variantId)),
          this.cache.delByPrefix(CACHE_KEYS.productStockPrefix(variantId)),
        ]),
      );
      totalUnlinked = counts.reduce((sum, n) => sum + n, 0);
    } catch (error) {
      this.logger.warn(
        { err: error as Error, correlationId, variantIds },
        'Failed to invalidate stock cache',
      );
      return;
    }

    if (totalUnlinked === 0) {
      this.logger.debug(
        { correlationId, variantIds, itemCount: items.length },
        'No matching stock cache keys to invalidate',
      );
      return;
    }

    this.logger.debug(
      {
        correlationId,
        variantIds,
        itemCount: items.length,
        keyCount: totalUnlinked,
      },
      'Stock cache invalidated via prefix delete',
    );
  }
}
