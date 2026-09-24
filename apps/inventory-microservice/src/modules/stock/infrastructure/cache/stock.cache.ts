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

@Injectable()
export class StockCache implements IStockCachePort {
  private static readonly JITTER_FRACTION = 0.1;

  constructor(
    @Inject(CACHE_PORT)
    private readonly cache: ICachePort,
    private readonly configService: ConfigService,
    @InjectPinoLogger(StockCache.name)
    private readonly logger: PinoLogger,
  ) {}

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

    if (!available) return loader();

    return this.cache.singleFlight(cacheKey, async () => {
      const insideLeader = await this.get(payload);
      if (insideLeader.value !== undefined) return insideLeader.value;

      const data = await loader();
      if (insideLeader.available) {
        await this.set({ variantId, stockLocationIds, tenantId, data, correlationId });
      }
      return data;
    });
  }

  private configuredTtl(): number {
    return this.configService.get<number>('CACHE_TTL_MS_PRODUCT_STOCK') ?? 60000;
  }

  private jitterTtl(ttl: number): number {
    const offset = (Math.random() * 2 - 1) * StockCache.JITTER_FRACTION * ttl;
    return Math.max(1, Math.floor(ttl + offset));
  }

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
