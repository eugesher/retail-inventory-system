import { Inject, Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';

import {
  IAllocationCancelPayload,
  StockMovementTypeEnum,
} from '@retail-inventory-system/contracts';

import {
  InventoryDomainException,
  InventoryErrorCodeEnum,
  StockMovement,
  StockReleasedEvent,
} from '../../domain';
import {
  IStockCachePort,
  IStockEventsPublisherPort,
  IStockMovementRepositoryPort,
  IStockRepositoryPort,
  ITransactionPort,
  ITransactionScope,
  OCC_RETRY_ATTEMPTS,
  STOCK_CACHE,
  STOCK_EVENTS_PUBLISHER,
  STOCK_MOVEMENT_REPOSITORY,
  STOCK_REPOSITORY,
  TRANSACTION_PORT,
} from '../ports';
import { emitMovementRecorded } from './movement-recorded.emitter';
import { isDuplicateEntryError } from './mysql-error.util';
import {
  INormalizedReservationLine,
  levelKey,
  loadDistinctLevels,
  normalizeReservationLines,
} from './reservation-mutation';
import { runWithStockWriteRetry } from './stock-mutation';

const DEFAULT_CANCEL_REASON = 'order-cancelled';

// The release `reason` carried on the post-commit `inventory.stock.released` event.
// A cancel is always an order-cancellation as far as the event union is concerned;
// the free-form `payload.reason` (which can be a custom ops note) lands in the
// movement's `reason_code`, not the typed event reason.
const CANCEL_EVENT_REASON = 'order-cancelled' as const;

// One cancelled line + the ledger row that records it, carried out of the
// transaction so the post-commit emits fire per line.
interface ICancelledLine {
  variantId: number;
  stockLocationId: string;
  quantity: number;
  movement: StockMovement;
}

// Cancel Allocation reverses an order's allocation (ADR-030 §4): per line it
// returns the allocated units to `available` (`StockLevel.releaseAllocated`) and
// appends one negative `release` movement referencing the order. Its callers are
// the later order-cancel capability and the place-failure compensation in the
// retail-wiring capability — it ships now as a fully-tested reserved surface with
// no in-repo caller.
//
// **No reservation rows are touched** — the holds are already `committed` (or never
// existed); cancelling an order does not resurrect a cart hold.
//
// **Idempotency is keyed on the caller's `operationKey`** (ADR-057), because this operation
// has no natural key of its own: Cancel Line cancels a QUANTITY, so the same
// `(order, line, variant, location)` can legitimately be released again later. The quantity
// check that used to stand alone here refuses only to go below zero — and on a counter
// several orders share, "still enough to subtract" is not "not yet done", so a redelivery
// could release a DIFFERENT order's units. An over-cancel is still a
// 409 `STOCK_RESULT_NEGATIVE`, not a silent no-op. Like allocate, the cancel is
// all-lines-atomic — every line is computed in memory (where an over-cancel throws)
// before any write, then every distinct level is persisted once and every movement
// appended, all inside one `withInvalidation(runWithStockWriteRetry(...))`.
@Injectable()
export class CancelAllocationUseCase {
  constructor(
    @Inject(TRANSACTION_PORT)
    private readonly transactionPort: ITransactionPort,
    @Inject(STOCK_REPOSITORY)
    private readonly repository: IStockRepositoryPort,
    @Inject(STOCK_MOVEMENT_REPOSITORY)
    private readonly movementRepository: IStockMovementRepositoryPort,
    @Inject(STOCK_CACHE)
    private readonly stockCache: IStockCachePort,
    @Inject(STOCK_EVENTS_PUBLISHER)
    private readonly publisher: IStockEventsPublisherPort,
    @Inject(OCC_RETRY_ATTEMPTS)
    private readonly maxAttempts: number,
    @InjectPinoLogger(CancelAllocationUseCase.name)
    private readonly logger: PinoLogger,
  ) {}

  public async execute(payload: IAllocationCancelPayload): Promise<{ cancelled: number }> {
    const { orderId, correlationId } = payload;
    const reasonCode = payload.reason ?? DEFAULT_CANCEL_REASON;
    const actorId = payload.actorId ?? null;

    this.logger.info(
      { correlationId, orderId, lineCount: payload.lines?.length, reasonCode },
      'Received RPC: cancel allocation',
    );

    const lines = normalizeReservationLines(payload.lines, 'Cancel allocation');
    // Backstop for the directly-reachable RMQ path — the retail caller always mints one
    // (ADR-057). Without it the dedupe key generates NULL and the write silently loses its
    // only guard, so an absent key is refused rather than accepted as "unkeyed".
    const operationKey = payload.operationKey?.trim();
    if (!operationKey) {
      throw new InventoryDomainException(
        InventoryErrorCodeEnum.RESERVATION_QUANTITY_INVALID,
        'Cancel allocation requires an operationKey — the identity that makes a redelivery recognisable',
      );
    }

    let cancelled: ICancelledLine[];
    try {
      cancelled = await this.stockCache.withInvalidation(
        () =>
          runWithStockWriteRetry(
            {
              transactionPort: this.transactionPort,
              logger: this.logger,
              maxAttempts: this.maxAttempts,
            },
            (scope) => this.cancelOnce(scope, orderId, lines, reasonCode, actorId, operationKey),
            { correlationId },
          ),
        // `withInvalidation` dedupes by variantId and wipes a per-variant prefix
        // covering every location facet, so the raw per-line items are enough.
        (rows) =>
          rows.map((row) => ({ variantId: row.variantId, stockLocationId: row.stockLocationId })),
        { correlationId },
      );
    } catch (error) {
      // THE GUARD, and the reason this operation needed a key at all (ADR-057). A release
      // whose `operation_key` is already in the ledger is a redelivery of work that has
      // ALREADY been applied — `UC_STOCK_MOVEMENT_DEDUPE` refuses the INSERT and the whole
      // transaction rolls back, so this attempt released nothing.
      //
      // Before the key existed, `releaseAllocated`'s quantity check was the only thing here,
      // and it cannot tell "already done" from "still enough to subtract" on a counter
      // several orders share — so a redelivered cancel could release a DIFFERENT order's
      // units, understating `quantity_allocated` and overselling. Never rethrow: an
      // exception out of an `@MessagePattern` is blind-redelivered by the broker in a hot
      // loop.
      if (isDuplicateEntryError(error)) {
        this.logger.info(
          { correlationId, orderId, operationKey },
          'Cancel allocation replay — this cancellation is already in the ledger, nothing released',
        );
        return { cancelled: lines.length };
      }
      throw error;
    }

    this.logger.info(
      { correlationId, orderId, cancelledCount: cancelled.length },
      'Allocation cancelled — units returned to available',
    );

    // Post-commit, best-effort (ADR-020), per cancelled line.
    await Promise.all(cancelled.map((row) => this.emitReleased(row, correlationId)));

    return { cancelled: cancelled.length };
  }

  // One transactional attempt: compute every line in memory first (so an over-cancel
  // leaves nothing persisted for ANY line), then write all. Re-reads each level fresh
  // under the scope so a retried attempt never double-applies.
  private async cancelOnce(
    scope: ITransactionScope,
    orderId: number,
    lines: INormalizedReservationLine[],
    reasonCode: string,
    actorId: string | null,
    operationKey: string,
  ): Promise<ICancelledLine[]> {
    // Phase 1 — load each distinct level once, capturing its optimistic token.
    const levels = await loadDistinctLevels(this.repository, lines, scope);

    // Phase 2 — compute per line (in-memory). `releaseAllocated` throws
    // STOCK_RESULT_NEGATIVE on an over-cancel here, before any write below.
    const computed: { line: INormalizedReservationLine; movement: StockMovement }[] = [];
    for (const line of lines) {
      const loaded = levels.get(levelKey(line.variantId, line.stockLocationId));
      // Unreachable: phase 1 inserted a level for every line's key.
      if (loaded === undefined) {
        throw new Error(`Cancel: level for ${line.variantId} @ ${line.stockLocationId} not loaded`);
      }
      loaded.level.releaseAllocated(line.quantity);

      computed.push({
        line,
        movement: StockMovement.record({
          variantId: line.variantId,
          stockLocationId: line.stockLocationId,
          type: StockMovementTypeEnum.RELEASE,
          quantity: -line.quantity,
          reasonCode,
          referenceType: 'order',
          referenceId: String(orderId),
          actorId,
          // The identity of THIS cancellation (ADR-057). `reference_id` stays the order —
          // an auditor still asks "what released order X?" — and the dedupe rides this
          // column instead, because an order can be cancelled from more than once.
          operationKey,
        }),
      });
    }

    // Phase 3 — write everything (all lines validated). No reservation rows touched.
    for (const { level, expectedVersion } of levels.values()) {
      await this.repository.persistStockLevelChange(level, expectedVersion, scope);
    }

    const cancelled: ICancelledLine[] = [];
    for (const { line, movement } of computed) {
      const appended = await this.movementRepository.append(movement, scope);
      cancelled.push({
        variantId: line.variantId,
        stockLocationId: line.stockLocationId,
        quantity: line.quantity,
        movement: appended,
      });
    }

    return cancelled;
  }

  private async emitReleased(row: ICancelledLine, correlationId: string): Promise<void> {
    try {
      await this.publisher.publishStockReleased(
        new StockReleasedEvent({
          variantId: row.variantId,
          stockLocationId: row.stockLocationId,
          quantity: row.quantity,
          // An order cancel releases by order, not by a single cart hold — both
          // `cartId` and `reservationId` are null (the event's nullable legs).
          cartId: null,
          reservationId: null,
          reason: CANCEL_EVENT_REASON,
        }),
        correlationId,
      );
    } catch (error) {
      this.logger.warn(
        { err: error as Error, correlationId, variantId: row.variantId },
        'Failed to publish inventory.stock.released (cancel already committed)',
      );
    }

    await emitMovementRecorded(this.publisher, this.logger, row.movement, correlationId);
  }
}
