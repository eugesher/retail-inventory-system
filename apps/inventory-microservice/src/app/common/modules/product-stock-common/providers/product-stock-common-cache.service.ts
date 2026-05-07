import { Cache, CACHE_MANAGER } from '@nestjs/cache-manager';
import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import KeyvRedis from '@keyv/redis';
import { Cacheable } from 'cacheable';
import { isDefined } from 'class-validator';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';

import { CacheHelper } from '@retail-inventory-system/common';
import { ProductStockGetResponseDto } from '@retail-inventory-system/inventory';
import {
  IProductStockCommonCacheGet,
  IProductStockCommonCacheInvalidate,
  IProductStockCommonCacheSet,
} from '../interfaces';

// Narrow structural type for the subset of the @redis/client v5 client we
// actually need. KeyvRedis exposes the client as a wide union
// (RedisClientType | RedisClusterType | RedisSentinelType) with empty
// module/function/script generics, which doesn't structurally match the
// generic signatures of scanIterator/unlink. Declaring just what we use
// sidesteps the generic mismatch without resorting to `any`.
interface IRedisScanClient {
  scanIterator(options: { MATCH: string; COUNT?: number }): AsyncIterable<string[]>;
  unlink(keys: string[]): Promise<number>;
}

// TTL has no jitter — all entries written together expire on the same
// wall-clock band, risking a thundering herd at the boundary. A ±10%
// multiplier on `ttl` in `set` would smooth it. Not applied today.
// AUDIT-2026-05-08 [CACHE-004]
//
// When Redis is unavailable, `get` warn-logs once, the façade falls through
// to DB, then `set` warn-logs again on the same outage. Net behavior is
// correct (request succeeds), but the log volume doubles. Could short-
// circuit with a brief in-process unavailability flag. Not applied today.
// AUDIT-2026-05-08 [CACHE-005]
//
// The SCAN path reaches through Cache → Cacheable.primary → store →
// KeyvRedis → adapter.client. Defensive guards are in place, but a
// `cacheable` major version bump may break this. Pin the major in
// package.json before next dep refresh.
// AUDIT-2026-05-08 [CACHE-006]
@Injectable()
export class ProductStockCommonCacheService {
  constructor(
    @Inject(CACHE_MANAGER)
    private readonly cache: Cache,
    private readonly configService: ConfigService,
    @InjectPinoLogger(ProductStockCommonCacheService.name)
    private readonly logger: PinoLogger,
  ) {}

  public async get(
    payload: IProductStockCommonCacheGet,
  ): Promise<ProductStockGetResponseDto | undefined> {
    const { productId, storageIds, correlationId } = payload;

    const cacheKey = CacheHelper.keys.productStock(productId, storageIds);

    try {
      const cached = await this.cache.get<ProductStockGetResponseDto>(cacheKey);
      const cacheHit = isDefined(cached);

      this.logger.debug(
        { correlationId, productId, cacheKey, cacheHit },
        cacheHit ? 'Cache hit for stock query' : 'Cache miss for stock query',
      );

      return cached;
    } catch (error) {
      this.logger.warn(
        { err: error as Error, correlationId, productId, cacheKey },
        'Failed to read from cache',
      );
    }
  }

  public async set(payload: IProductStockCommonCacheSet): Promise<void> {
    const { productId, storageIds, data, correlationId } = payload;

    const cacheKey = CacheHelper.keys.productStock(productId, storageIds);
    const ttl = this.configService.get<number>('CACHE_TTL_MS_PRODUCT_STOCK');

    try {
      await this.cache.set(cacheKey, data, ttl);

      this.logger.debug({ correlationId, productId, cacheKey, ttl }, 'Cache write for stock query');
    } catch (error) {
      this.logger.warn(
        { err: error as Error, correlationId, productId, cacheKey },
        'Failed to write to cache',
      );
    }
  }

  public async invalidate(payload: IProductStockCommonCacheInvalidate): Promise<void> {
    const { items, correlationId } = payload;

    if (items.length === 0) {
      return;
    }

    const productIds = [...new Set(items.map((i) => i.productId))];

    const adapter = this.getRedisAdapter();

    if (!adapter) {
      // Defensive fallback for non-Redis backends (e.g. an in-memory store
      // swapped in for unit tests). We can't enumerate keys without SCAN, so
      // delete the two keys we can name explicitly per (productId, storageId):
      //   - the unfiltered key  `stock:<productId>:*` (literal '*' suffix)
      //   - the single-storage key `stock:<productId>:<storageId>`
      // Multi-storage combo keys remain TTL-bound. This branch is best-effort.
      await this.invalidateNamedKeys(items, correlationId);
      return;
    }

    const rawClient = adapter.client;

    if (!('scanIterator' in rawClient) || !('unlink' in rawClient)) {
      // Cluster / Sentinel clients don't expose scanIterator on the top-level
      // client (you'd have to fan out per shard). The project uses a single
      // Redis instance, so this branch should never hit in practice. Fall back
      // to named-key invalidation if it does.
      this.logger.warn(
        { correlationId },
        'Redis client does not expose scanIterator; falling back to named-key invalidation',
      );
      await this.invalidateNamedKeys(items, correlationId);
      return;
    }

    const client = rawClient as unknown as IRedisScanClient;
    // KeyvRedis prefixes stored keys with `${namespace}${keyPrefixSeparator}`
    // when a namespace is configured. With no namespace (the project default,
    // see libs/config/cache-module.config.ts) the prefix is empty and stored
    // keys match cache.set() input verbatim. Computing the prefix at runtime
    // keeps this code correct if a namespace is added later.
    const keyPrefix = adapter.namespace ? `${adapter.namespace}${adapter.keyPrefixSeparator}` : '';

    const matchedKeys = new Set<string>();

    try {
      // Per-productId SCANs run in parallel — they share no state (each writes
      // into the same Set, but JS's single-threaded event loop makes that safe)
      // and avoid stacking SCAN-cycle latency for multi-product invalidations.
      // scanIterator yields BATCHES of keys (string[]) per SCAN cycle on
      // @redis/client v5. Deduplicate via Set — SCAN can return the same
      // key in different cycles under concurrent rehash conditions.
      await Promise.all(
        productIds.map(async (productId) => {
          const pattern = `${keyPrefix}${CacheHelper.keyPrefixes.productStock(productId)}*`;

          for await (const batch of client.scanIterator({ MATCH: pattern, COUNT: 100 })) {
            for (const key of batch) {
              matchedKeys.add(key);
            }
          }
        }),
      );
    } catch (error) {
      this.logger.warn(
        { err: error as Error, correlationId, productIds },
        'SCAN failed during stock cache invalidation',
      );
      return;
    }

    if (matchedKeys.size === 0) {
      this.logger.debug(
        { correlationId, productIds, itemCount: items.length },
        'No matching stock cache keys to invalidate',
      );
      return;
    }

    try {
      // UNLINK frees memory asynchronously on the Redis side — preferred over
      // DEL when invalidating potentially-large key sets, since DEL is O(N)
      // synchronous from Redis's main thread.
      await client.unlink([...matchedKeys]);

      this.logger.debug(
        {
          correlationId,
          productIds,
          itemCount: items.length,
          keyCount: matchedKeys.size,
        },
        'Stock cache invalidated via SCAN+UNLINK',
      );
    } catch (error) {
      this.logger.warn(
        { err: error as Error, correlationId, productIds, keyCount: matchedKeys.size },
        'UNLINK failed during stock cache invalidation',
      );
    }
  }

  private getRedisAdapter(): KeyvRedis<unknown> | undefined {
    // The Cache provider from @nestjs/cache-manager is structurally a
    // Cacheable instance from the `cacheable` package. Reach through it to
    // the primary Keyv-wrapped store, then to its underlying adapter.
    const cacheable = this.cache as unknown as Cacheable;
    const primary: { store?: unknown } | undefined = cacheable.primary;
    const store = primary?.store;

    return store instanceof KeyvRedis ? (store as KeyvRedis<unknown>) : undefined;
  }

  // AUDIT-2026-05-08 [CACHE-012] bug
  // This fallback enumerates only `stock:<productId>:*` and the single
  // `stock:<productId>:<storageId>` key per item. Multi-storage combo keys
  // (e.g. `stock:1:storage-a,storage-b`) survive until TTL on non-Redis
  // backends. Either accept-and-document as best-effort (the call site at
  // line ~111 already says "best-effort"), or enumerate combo keys via the
  // in-memory adapter's iterator interface.
  private async invalidateNamedKeys(
    items: IProductStockCommonCacheInvalidate['items'],
    correlationId?: string,
  ): Promise<void> {
    const cacheKeys = new Set<string>();

    for (const { productId, storageId } of items) {
      cacheKeys.add(CacheHelper.keys.productStock(productId));
      cacheKeys.add(CacheHelper.keys.productStock(productId, [storageId]));
    }

    try {
      await Promise.all([...cacheKeys].map((key) => this.cache.del(key)));

      this.logger.debug(
        { correlationId, itemCount: items.length, keyCount: cacheKeys.size },
        'Stock cache invalidated via named-key fallback',
      );
    } catch (error) {
      this.logger.warn(
        { err: error as Error, correlationId, itemCount: items.length },
        'Failed to invalidate stock cache (fallback path)',
      );
    }
  }
}
