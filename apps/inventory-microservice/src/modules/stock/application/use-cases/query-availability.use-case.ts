import { Inject, Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';

import {
  IVariantStockGetPayload,
  StockLevelView,
  VariantStockView,
} from '@retail-inventory-system/contracts';

import { StockLevel } from '../../domain';
import { IStockCachePort, IStockRepositoryPort, STOCK_CACHE, STOCK_REPOSITORY } from '../ports';

// Query Availability is the read path on the new model (ADR-027): given a
// `variantId` (optionally scoped to a stock-location subset), return the
// per-location `StockLevel` projection plus the cross-location totals.
//
// Cache-aside through `stockCache.getOrLoad` (ADR-002 / ADR-006 / ADR-021): on a
// hit the cached `VariantStockView` is returned without touching the DB; on a
// miss the loader runs the point lookup, projects each row, and the helper writes
// the value back with a jittered TTL behind a single-flight. There is no
// transactional / skip-cache branch on this read path (no caller-owned scope), so
// the use case stays a one-liner over `getOrLoad`.
@Injectable()
export class QueryAvailabilityUseCase {
  constructor(
    @Inject(STOCK_REPOSITORY)
    private readonly repository: IStockRepositoryPort,
    @Inject(STOCK_CACHE)
    private readonly stockCache: IStockCachePort,
    @InjectPinoLogger(QueryAvailabilityUseCase.name)
    private readonly logger: PinoLogger,
  ) {}

  public async execute(payload: IVariantStockGetPayload): Promise<VariantStockView> {
    const { variantId, stockLocationIds, correlationId } = payload;

    this.logger.info(payload, 'Received RPC: query variant availability');

    try {
      return await this.stockCache.getOrLoad({ variantId, stockLocationIds, correlationId }, () =>
        this.load(variantId, stockLocationIds),
      );
    } catch (error) {
      this.logger.error({ err: error as Error, ...payload }, 'Error querying variant availability');
      throw error;
    }
  }

  // The cache-miss loader: one point lookup of the variant's stock-level rows,
  // projected onto the wire view and aggregated. An empty result is a valid
  // value (`locations: []`, totals `0`) — a variant with no stock rows for the
  // requested scope is "zero available everywhere", not an error.
  private async load(variantId: number, stockLocationIds?: string[]): Promise<VariantStockView> {
    const levels = await this.repository.findStockLevelsByVariant(variantId, stockLocationIds);

    // Stable, documented order so the cached value is deterministic for a given
    // DB state (the repository `find` does not order). Matches the cache-facet
    // `localeCompare` convention (ADR-016).
    const locations = levels
      .map((level) => this.toView(level))
      .sort((a, b) => a.stockLocationId.localeCompare(b.stockLocationId));

    const totalOnHand = locations.reduce((sum, location) => sum + location.quantityOnHand, 0);
    const totalAvailable = locations.reduce((sum, location) => sum + location.available, 0);

    return { variantId, totalOnHand, totalAvailable, locations };
  }

  private toView(level: StockLevel): StockLevelView {
    return {
      stockLocationId: level.stockLocationId,
      quantityOnHand: level.quantityOnHand,
      quantityAllocated: level.quantityAllocated,
      quantityReserved: level.quantityReserved,
      // `available` is the domain getter (onHand − allocated − reserved); the
      // total is the sum of these per-location derived values.
      available: level.available,
      version: level.version,
      updatedAt: level.updatedAt,
    };
  }
}
