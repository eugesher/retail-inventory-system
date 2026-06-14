import { Inject, Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';

import {
  IPage,
  IStockMovementListPayload,
  StockMovementView,
} from '@retail-inventory-system/contracts';

import { IStockMovementRepositoryPort, STOCK_MOVEMENT_REPOSITORY } from '../ports';
import { toStockMovementView } from './stock-movement-view.factory';

// List Stock Movements: the audit read of one variant's append-only
// `stock_movement` ledger (ADR-030 §2). A paginated, newest-first
// (`occurred_at DESC, id DESC` — ordering owned by the repository) timeline,
// optionally narrowed by `type` and an inclusive `occurred_at` window.
//
// **Uncached by design.** Unlike the per-variant availability read (cache-aside,
// ADR-002), the ledger grows monotonically and an audit query is low-frequency,
// operator-driven, and expects to see the *latest* rows — caching would add an
// invalidation hop on every counter-changing operation (which all append a
// movement) for no hit-rate benefit. So this use case takes no `STOCK_CACHE`.
//
// An unknown variant (or a variant with no movements) is a valid answer — an empty
// page (`items: []`, `total: 0`), not a 404. There is deliberately no
// existence probe: the read is the public-read zero-answer convention, mirroring
// the per-variant stock read.
@Injectable()
export class ListStockMovementsUseCase {
  constructor(
    @Inject(STOCK_MOVEMENT_REPOSITORY)
    private readonly movementRepository: IStockMovementRepositoryPort,
    @InjectPinoLogger(ListStockMovementsUseCase.name)
    private readonly logger: PinoLogger,
  ) {}

  public async execute(payload: IStockMovementListPayload): Promise<IPage<StockMovementView>> {
    const { variantId, page, size, type, from, to, correlationId } = payload;

    this.logger.info(
      { correlationId, variantId, page, size, type, from, to },
      'Received RPC: list stock movements (audit read)',
    );

    // Parse the ISO bounds into `Date`s, treating an unparseable value as absent —
    // the gateway DTO (`@IsISO8601()`) is the validation gate, so by the time a
    // request reaches here a malformed bound means "no bound", never a 4xx from the
    // read path.
    const fromDate = this.parseInstant(from);
    const toDate = this.parseInstant(to);

    const movementsPage = await this.movementRepository.listByVariant({
      variantId,
      page,
      size,
      type,
      from: fromDate,
      to: toDate,
    });

    // `page` / `size` are echoed from the request (the applied paging); `total` is
    // the repository's full-match count, so a client can compute the page count.
    return {
      items: movementsPage.items.map((movement) => toStockMovementView(movement)),
      total: movementsPage.total,
      page,
      size,
    };
  }

  // ISO-8601 → `Date`, or `undefined` when absent / unparseable. `new Date(bad)`
  // yields an Invalid Date whose `getTime()` is `NaN` — the absent-on-garbage rule.
  private parseInstant(value?: string): Date | undefined {
    if (value === undefined) {
      return undefined;
    }
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? undefined : parsed;
  }
}
