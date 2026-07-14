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

    // **Exactly ONE prefix per variant — one Redis SCAN + UNLINK per variant per write.**
    // `delByPrefix` is a SCAN, not a keyspace lookup, and this runs on the hot path of every
    // receive, adjust, reserve, release, allocate, commit-sale, restock and transfer.
    //
    // This used to fan out to **five**: the live `v3` key plus the four retired shapes (`v2`, `v1`,
    // the unversioned pre-v1, and the pre-ADR-016 `stock:<productId>:` convention), swept so a
    // rolling deploy could not serve entries a previous key version had written. Four of those five
    // SCANs **could never match anything, and could not have mattered if they had**: there is no
    // read path for a retired shape — `cache-keys.ts` exposes no full-key builder for one — so an
    // entry under an old key is unreachable garbage that no request could ever be served, and it
    // expires on its own TTL. Sweeping it bought nothing and cost a SCAN per write, forever
    // (ISSUE-03).
    //
    // **The builders survive in `libs/cache/cache-keys.ts` and now have no caller at all** — kept as
    // a registry of the retired shapes, on ADR-046's "a complete registry is the point" basis, not
    // because anything is defending against them. Nothing is: the project has never deployed, so no
    // Redis anywhere holds a key in any of those shapes.
    //
    // Do not re-add a sweep here. If a future key bump genuinely needs a transition window, it needs
    // one with an owner and a close date — not a permanent tax on every write (ADR-046: *"a deletion
    // queued behind a condition, with no owner and no check, is not queued — it is forgotten"*). The
    // condition on these four ("after the rolling deploy completes") was met three times and nobody
    // acted, which is how five SCANs ended up on the hot path.
    let totalUnlinked = 0;
    try {
      const counts = await Promise.all(
        variantIds.map((variantId) =>
          this.cache.delByPrefix(CACHE_KEYS.inventoryStockPrefix(variantId, { tenantId })),
        ),
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
