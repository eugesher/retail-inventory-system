import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';

import { CACHE_KEYS, CACHE_PORT, ICachePort } from '@retail-inventory-system/cache';
import { ProductStockGetResponseDto } from '@retail-inventory-system/contracts';

import {
  IStockCacheGetPayload,
  IStockCacheInvalidatePayload,
  IStockCachePort,
  IStockCacheSetPayload,
} from '../../application/ports';

// Stock-cache adapter: implements the domain-shaped `IStockCachePort`
// over the generic `ICachePort` (libs/cache). The port handles SCAN+UNLINK
// for prefix invalidation; this class only knows the stock cache-key
// shape (delegated to `CACHE_KEYS.inventoryStock*` per ADR-016).
//
// Open audit items still tracked here, not addressed by task-11:
//   * CACHE-001 — read/write race / no single-flight
//   * CACHE-003 — no schema-version segment in keys
//   * CACHE-004 — TTL has no jitter
//   * CACHE-005 — duplicate warn logs on Redis-down
//   * CACHE-006 — `cacheable` major-bump fragility
@Injectable()
export class StockCache implements IStockCachePort {
  constructor(
    @Inject(CACHE_PORT)
    private readonly cache: ICachePort,
    private readonly configService: ConfigService,
    @InjectPinoLogger(StockCache.name)
    private readonly logger: PinoLogger,
  ) {}

  public async get(
    payload: IStockCacheGetPayload,
  ): Promise<ProductStockGetResponseDto | undefined> {
    const { productId, storageIds, correlationId } = payload;
    const cacheKey = CACHE_KEYS.inventoryStock(productId, storageIds);

    try {
      const cached = await this.cache.get<ProductStockGetResponseDto>(cacheKey);
      const cacheHit = cached !== undefined;

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
      return undefined;
    }
  }

  public async set(payload: IStockCacheSetPayload): Promise<void> {
    const { productId, storageIds, data, correlationId } = payload;
    const cacheKey = CACHE_KEYS.inventoryStock(productId, storageIds);
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

  public async invalidate(payload: IStockCacheInvalidatePayload): Promise<void> {
    const { items, correlationId } = payload;
    if (items.length === 0) return;

    const productIds = [...new Set(items.map((i) => i.productId))];

    // Two prefixes are wiped per productId:
    //   * `ris:inventory:stock:<productId>:` — the post-ADR-016 shape
    //   * `stock:<productId>:`               — the pre-ADR-016 legacy shape,
    //                                          covered for one rolling deploy
    //                                          so in-flight entries written
    //                                          before the cut-over do not
    //                                          survive a write.
    let totalUnlinked = 0;
    try {
      const counts = await Promise.all(
        productIds.flatMap((productId) => [
          this.cache.delByPrefix(CACHE_KEYS.inventoryStockPrefix(productId)),
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
