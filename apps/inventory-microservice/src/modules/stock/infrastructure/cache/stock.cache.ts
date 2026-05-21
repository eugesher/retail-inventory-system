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

// Audit closures: CACHE-001/004 by ADR-021 (single-flight + jitter),
// CACHE-003/009 by ADR-022 (schema-version + opt-in tenant segments),
// CACHE-005 by the `available` flag from `get` (Redis-down request emits
// one warn instead of three).
@Injectable()
export class StockCache implements IStockCachePort {
  // ADR-021 ±10% TTL jitter; the floor preserves ADR-002's TTL-as-safety-net
  // role so a missed invalidate still has a bounded staleness window.
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

    // CACHE-005: outer `get` already warn-logged on outage; skip the
    // single-flight + write-back to avoid duplicate warns against a dead
    // client. DB fallback continues via the direct loader call.
    if (!available) return loader();

    // Re-check inside the leader handles the rare race where a hit lands
    // between the outer `get` and the leader starting.
    return this.cache.singleFlight(cacheKey, async () => {
      const insideLeader = await this.get(payload);
      if (insideLeader.value !== undefined) return insideLeader.value;

      const data = await loader();
      // Inner re-check may observe an outage the outer read missed; skip
      // the write-back so we do not emit a second warn.
      if (insideLeader.available) {
        await this.set({ productId, storageIds, tenantId, data, correlationId });
      }
      return data;
    });
  }

  private configuredTtl(): number {
    // Defensive coerce: the Joi schema in libs/config supplies a default,
    // but some unit-test bootstraps skip env loading.
    return this.configService.get<number>('CACHE_TTL_MS_PRODUCT_STOCK') ?? 60000;
  }

  private jitterTtl(ttl: number): number {
    // Symmetric ±JITTER_FRACTION; floor()ed for the integer-ms contract of
    // `ICachePort.set`.
    const offset = (Math.random() * 2 - 1) * StockCache.JITTER_FRACTION * ttl;
    return Math.floor(ttl + offset);
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
    const productIds = [...new Set(items.map((i) => i.productId))];

    // ADR-022 transition window — three prefixes per productId:
    //   * v1 (tenanted, CACHE-003 / CACHE-009)
    //   * pre-v1 post-ADR-016 (single-tenant — never carried a tenant segment)
    //   * pre-ADR-016 legacy (single-tenant by construction)
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
