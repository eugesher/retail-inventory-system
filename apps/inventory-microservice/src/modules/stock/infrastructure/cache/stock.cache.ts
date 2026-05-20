import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';

import { CACHE_KEYS, CACHE_PORT, ICachePort } from '@retail-inventory-system/cache';
import { ProductStockGetResponseDto } from '@retail-inventory-system/contracts';

import {
  IStockCacheGetPayload,
  IStockCacheGetResult,
  IStockCacheInvalidateItem,
  IStockCachePort,
  IStockCacheSetPayload,
  IStockWithInvalidationOptions,
} from '../../application/ports';

// Stock-cache adapter: implements the domain-shaped `IStockCachePort`
// over the generic `ICachePort` (libs/cache). The port handles SCAN+UNLINK
// for prefix invalidation; this class only knows the stock cache-key
// shape (delegated to `CACHE_KEYS.inventoryStock*` per ADR-016 + ADR-022).
//
// CACHE-001 / CACHE-004 closed by ADR-021 (single-flight in `getOrLoad`,
// ±10% jitter inside `set`).
// CACHE-003 / CACHE-009 closed by ADR-022 (schema-version segment +
// opt-in tenant segment in the key shape).
// CACHE-005 closed by the `available` flag returned from `get`: when
// the read fails, `getOrLoad` short-circuits the write-back path so a
// single Redis-down request produces exactly one warn instead of three.
@Injectable()
export class StockCache implements IStockCachePort {
  // ADR-021: ±10% TTL jitter spreads expiries of correlated writes so a
  // batch landing in one tick does not stampede at the TTL boundary.
  // The floor (`ttl * 0.9`) preserves ADR-002's TTL-as-safety-net role —
  // a missed invalidate still produces a bounded staleness window.
  private static readonly JITTER_FRACTION = 0.1;

  constructor(
    @Inject(CACHE_PORT)
    private readonly cache: ICachePort,
    private readonly configService: ConfigService,
    @InjectPinoLogger(StockCache.name)
    private readonly logger: PinoLogger,
  ) {}

  public async get(payload: IStockCacheGetPayload): Promise<IStockCacheGetResult> {
    const { productId, storageIds, tenantId, correlationId } = payload;
    const cacheKey = CACHE_KEYS.inventoryStock(productId, storageIds, { tenantId });

    try {
      const cached = await this.cache.get<ProductStockGetResponseDto>(cacheKey);
      const cacheHit = cached !== undefined;

      this.logger.debug(
        { correlationId, productId, cacheKey, cacheHit },
        cacheHit ? 'Cache hit for stock query' : 'Cache miss for stock query',
      );

      return { value: cached, available: true };
    } catch (error) {
      this.logger.warn(
        { err: error as Error, correlationId, productId, cacheKey },
        'Failed to read from cache',
      );
      return { value: undefined, available: false };
    }
  }

  public async set(payload: IStockCacheSetPayload): Promise<void> {
    const { productId, storageIds, tenantId, data, correlationId } = payload;
    const cacheKey = CACHE_KEYS.inventoryStock(productId, storageIds, { tenantId });
    const ttl = this.jitterTtl(this.configuredTtl());

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

  public async getOrLoad(
    payload: IStockCacheGetPayload,
    loader: () => Promise<ProductStockGetResponseDto>,
  ): Promise<ProductStockGetResponseDto> {
    const { productId, storageIds, tenantId, correlationId } = payload;
    const cacheKey = CACHE_KEYS.inventoryStock(productId, storageIds, { tenantId });

    const { value, available } = await this.get(payload);
    if (value !== undefined) return value;

    // CACHE-005: when the read failed (Redis-down), the outer `get` has
    // already warn-logged. There is no point joining the single-flight
    // cohort or attempting a write-back — both would just re-touch a
    // dead client and emit duplicate warns. Fall through to a direct
    // loader call so the DB fallback continues to serve the request.
    if (!available) return loader();

    // Miss path: dedupe concurrent loads via the port-level single-flight.
    // Re-check inside the leader handles the (rare) race where a hit lands
    // between the outer `get` above and the leader starting; followers
    // arriving after that point are still served by this same leader.
    return this.cache.singleFlight(cacheKey, async () => {
      const insideLeader = await this.get(payload);
      if (insideLeader.value !== undefined) return insideLeader.value;

      const data = await loader();
      // If the inner re-check observed an outage that the outer read did
      // not, skip the write-back too — `set` would just produce a second
      // warn against a Redis we already know is down.
      if (insideLeader.available) {
        await this.set({ productId, storageIds, tenantId, data, correlationId });
      }
      return data;
    });
  }

  private configuredTtl(): number {
    // The Joi schema in libs/config defines CACHE_TTL_MS_PRODUCT_STOCK with
    // a numeric default, so a missing value would be a misconfiguration
    // rather than a runtime branch. Coerce defensively in case env loading
    // is skipped (e.g. some unit-test bootstraps).
    return this.configService.get<number>('CACHE_TTL_MS_PRODUCT_STOCK') ?? 60000;
  }

  private jitterTtl(ttl: number): number {
    // Symmetric ±JITTER_FRACTION around the configured TTL. `Math.random()`
    // is uniform on [0, 1); mapping to [-1, 1) then scaling keeps the
    // result in [ttl * (1 - f), ttl * (1 + f)) and floor()ed for the
    // integer-ms contract of `ICachePort.set`.
    const offset = (Math.random() * 2 - 1) * StockCache.JITTER_FRACTION * ttl;
    return Math.floor(ttl + offset);
  }

  // ADR-023: `withInvalidation` is the only public path that drives cache
  // invalidation on write. Running the prefix delete is intentionally
  // private — the post-commit ordering is encoded in this method's body
  // (work first, then invalidate). A caller cannot reach the underlying
  // prefix-delete from inside their transaction callback because the type
  // signature forbids it.
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
    const productIds = [...new Set(items.map((i) => i.productId))];

    // Three prefixes are wiped per productId (ADR-022 transition window):
    //   * `ris:[t:<tenantId>:]inventory:stock:v1:<productId>:`
    //       — the current v1 shape (CACHE-003 / CACHE-009)
    //   * `ris:inventory:stock:<productId>:`
    //       — the pre-v1 (post-ADR-016) shape; covered for one rolling
    //         deploy so in-flight entries written before v1 do not
    //         survive a write. Unconditionally single-tenant — the pre-v1
    //         shape never carried a tenant segment.
    //   * `stock:<productId>:`
    //       — the pre-ADR-016 legacy shape, still wiped for the original
    //         ADR-016 transition window. Also single-tenant by construction.
    let totalUnlinked = 0;
    try {
      const counts = await Promise.all(
        productIds.flatMap((productId) => [
          this.cache.delByPrefix(CACHE_KEYS.inventoryStockPrefix(productId, { tenantId })),
          this.cache.delByPrefix(CACHE_KEYS.inventoryStockLegacyPrefix(productId)),
          this.cache.delByPrefix(CACHE_KEYS.productStockPrefix(productId)),
        ]),
      );
      totalUnlinked = counts.reduce((sum, n) => sum + n, 0);
    } catch (error) {
      this.logger.warn(
        { err: error as Error, correlationId, productIds },
        'Failed to invalidate stock cache',
      );
      return;
    }

    if (totalUnlinked === 0) {
      this.logger.debug(
        { correlationId, productIds, itemCount: items.length },
        'No matching stock cache keys to invalidate',
      );
      return;
    }

    this.logger.debug(
      {
        correlationId,
        productIds,
        itemCount: items.length,
        keyCount: totalUnlinked,
      },
      'Stock cache invalidated via prefix delete',
    );
  }
}
