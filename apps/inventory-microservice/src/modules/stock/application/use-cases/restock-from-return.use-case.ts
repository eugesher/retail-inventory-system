import { Inject, Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';

import {
  IRestockFromReturnLine,
  IRestockFromReturnPayload,
  IRestockFromReturnResult,
  IRestockFromReturnResultEntry,
  StockMovementTypeEnum,
} from '@retail-inventory-system/contracts';

import {
  InventoryDomainException,
  InventoryErrorCodeEnum,
  StockMovement,
  StockReturnedEvent,
} from '../../domain';
import {
  IStockCachePort,
  IStockEventsPublisherPort,
  IStockMovementRepositoryPort,
  IStockRepositoryPort,
  ITransactionPort,
  ITransactionScope,
  STOCK_CACHE,
  STOCK_EVENTS_PUBLISHER,
  STOCK_MOVEMENT_REPOSITORY,
  STOCK_REPOSITORY,
  TRANSACTION_PORT,
} from '../ports';
import { emitMovementRecorded } from './movement-recorded.emitter';
import { INormalizedReservationLine, levelKey, loadDistinctLevels } from './reservation-mutation';
import { runWithStockWriteRetry } from './stock-mutation';

// The ledger-reference family the restock idempotency probe + the `return`
// movements key on: `(reference_type='return-request', reference_id=returnRequestId)`.
// `'return-request'` is the documented `referenceType` value for return-driven
// movements (ADR-030 §2).
const RETURN_REQUEST_REFERENCE_TYPE = 'return-request';

// A restock line normalized at the edge — quantity validated, location resolved.
// Extends `INormalizedReservationLine` so it can be handed to the shared
// `loadDistinctLevels` / `levelKey` helpers; the extra `returnLineId` rides along
// so each restocked line can name the `ReturnLine` it satisfied in the result +
// the emitted event.
interface INormalizedRestockLine extends INormalizedReservationLine {
  returnLineId: number;
}

// One restocked line + the ledger row that records it, carried out of the
// transaction so the post-commit emits fire per line.
interface IRestockedLine {
  returnLineId: number;
  variantId: number;
  stockLocationId: string;
  quantity: number;
  movement: StockMovement;
}

interface IRestockOutcome {
  lines: IRestockedLine[];
}

// Backstop for the directly-reachable RMQ path (the retail caller validates first):
// a non-empty line list, each with a positive-integer quantity. A dedicated
// normalizer (rather than the shared `normalizeReservationLines`) because the
// restock line carries an extra `returnLineId` the allocate/commit-sale line shape
// does not, and its `stockLocationId` is required (the retail caller resolves the
// receiving location before sending), not optional.
function normalizeRestockLines(
  lines: IRestockFromReturnLine[] | undefined,
  label: string,
): INormalizedRestockLine[] {
  if (!Array.isArray(lines) || lines.length === 0) {
    throw new InventoryDomainException(
      InventoryErrorCodeEnum.RESERVATION_QUANTITY_INVALID,
      `${label} requires a non-empty lines array`,
    );
  }

  return lines.map((line) => {
    if (!Number.isInteger(line.quantity) || line.quantity <= 0) {
      throw new InventoryDomainException(
        InventoryErrorCodeEnum.RESERVATION_QUANTITY_INVALID,
        `${label} line quantity must be a positive integer, got ${line.quantity}`,
      );
    }
    return {
      returnLineId: line.returnLineId,
      variantId: line.variantId,
      stockLocationId: line.stockLocationId,
      quantity: line.quantity,
    };
  });
}

// Restock from Return physically returns a return request's `restock`-disposition
// stock to sellable inventory at inspection time (ADR-032). Per line it puts units
// back IN to `quantity_on_hand` (one positive `StockLevel.changeOnHand(+quantity)`
// — reserved/allocated untouched, so `available` rises by the same amount) and
// appends one strictly-positive `return` `StockMovement` referencing the return
// request. This is the long-reserved `return` ledger type's FIRST producer (ADR-030
// §2 shipped the enum; the mirror of ADR-031's `sale` from Commit Sale).
//
// **Idempotent on `returnRequestId`**: a `return` movement already referencing this
// return request means the restock already happened, so a re-delivery (the
// cross-service retry path — retail drives this AFTER its local inspect commits, so
// a transient RMQ failure can re-deliver) increments nothing and re-returns the
// prior result. The probe runs BEFORE any write, against the ledger's
// `(reference_type, reference_id)` index. One Inspect → one restock RPC per return,
// so per-request idempotency is the right grain (the Commit Sale `fulfillmentId`
// precedent).
//
// **All-lines-atomic**: every line is computed in memory before ANY persist, then
// every distinct level is persisted once and every movement appended, all inside
// one `withInvalidation(runWithStockWriteRetry(...))` — a rejection on any line
// rolls the whole transaction back (the Commit Sale precedent). No reservation rows
// are touched. **No low-stock re-fire** — a restock only RAISES on-hand, so it can
// never cross the low-stock threshold downward.
@Injectable()
export class RestockFromReturnUseCase {
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
    @InjectPinoLogger(RestockFromReturnUseCase.name)
    private readonly logger: PinoLogger,
  ) {}

  public async execute(payload: IRestockFromReturnPayload): Promise<IRestockFromReturnResult> {
    const { returnRequestId, correlationId } = payload;
    const actorId = payload.actorId ?? null;

    this.logger.info(
      { correlationId, returnRequestId, lineCount: payload.lines?.length },
      'Received RPC: restock from return',
    );

    const lines = normalizeRestockLines(payload.lines, 'Restock from return');
    const referenceId = String(returnRequestId);

    // Idempotency-first (ADR-032): if a `return` movement already references this
    // return request the restock already happened — re-return the request's lines
    // WITHOUT incrementing again. Skipping the whole `withInvalidation` is correct:
    // nothing changed, so there is nothing to invalidate.
    const alreadyRestocked = await this.movementRepository.existsByReference(
      RETURN_REQUEST_REFERENCE_TYPE,
      referenceId,
    );
    if (alreadyRestocked) {
      this.logger.info(
        { correlationId, returnRequestId },
        'Restock replay — return request already restocked, returning prior result without incrementing',
      );
      return { restocked: lines.map((line) => this.toEntry(line)) };
    }

    const outcome = await this.stockCache.withInvalidation(
      () =>
        runWithStockWriteRetry(
          { transactionPort: this.transactionPort, logger: this.logger },
          (scope) => this.restockOnce(scope, returnRequestId, lines, actorId),
          { correlationId },
        ),
      // `withInvalidation` dedupes by variantId and wipes a per-variant prefix
      // covering every location facet, so the raw per-line items are enough.
      (result) =>
        result.lines.map((row) => ({
          variantId: row.variantId,
          stockLocationId: row.stockLocationId,
        })),
      { correlationId },
    );

    this.logger.info(
      { correlationId, returnRequestId, restockedCount: outcome.lines.length },
      'Stock restocked — returned units back on-hand',
    );

    // Post-commit, best-effort (ADR-020): per line the returned + recorded events.
    // No low-stock re-check — on-hand only rose.
    await Promise.all(
      outcome.lines.map((row) => this.emitReturned(row, returnRequestId, correlationId)),
    );

    return { restocked: outcome.lines.map((row) => this.toEntry(row)) };
  }

  // One transactional attempt: compute every line in memory first (so a rejection
  // leaves nothing persisted for ANY line), then write all. Re-reads each level
  // fresh under the scope so a retried attempt never double-applies.
  private async restockOnce(
    scope: ITransactionScope,
    returnRequestId: number,
    lines: INormalizedRestockLine[],
    actorId: string | null,
  ): Promise<IRestockOutcome> {
    // Phase 1 — load each distinct level once (lazy-init a missing one: a returned
    // variant may have no level at the receiving location, e.g. a fresh location —
    // the Receive precedent), capturing its optimistic token before any mutation.
    const levels = await loadDistinctLevels(this.repository, lines, scope);

    // Phase 2 — compute per line (in-memory). `changeOnHand(+quantity)` raises
    // on-hand; the movement constructor re-asserts the strictly-positive `return`
    // sign. Both run before any write below.
    const referenceId = String(returnRequestId);
    const computed: { line: INormalizedRestockLine; movement: StockMovement }[] = [];
    for (const line of lines) {
      const key = levelKey(line.variantId, line.stockLocationId);
      const loaded = levels.get(key);
      // Unreachable: phase 1 inserted a level for every line's key.
      if (loaded === undefined) {
        throw new Error(
          `Restock from return: level for ${line.variantId} @ ${line.stockLocationId} not loaded`,
        );
      }
      loaded.level.changeOnHand(line.quantity);

      computed.push({
        line,
        movement: StockMovement.record({
          variantId: line.variantId,
          stockLocationId: line.stockLocationId,
          type: StockMovementTypeEnum.RETURN,
          quantity: line.quantity, // strictly positive — the fixed `return` sign
          reasonCode: null,
          referenceType: RETURN_REQUEST_REFERENCE_TYPE,
          referenceId,
          actorId,
        }),
      });
    }

    // Phase 3 — write everything (all lines validated). No reservation rows touched.
    for (const { level, expectedVersion } of levels.values()) {
      await this.repository.persistStockLevelChange(level, expectedVersion, scope);
    }

    const restockedLines: IRestockedLine[] = [];
    for (const { line, movement } of computed) {
      const appended = await this.movementRepository.append(movement, scope);
      restockedLines.push({
        returnLineId: line.returnLineId,
        variantId: line.variantId,
        stockLocationId: line.stockLocationId,
        quantity: line.quantity,
        movement: appended,
      });
    }

    return { lines: restockedLines };
  }

  private toEntry(line: INormalizedRestockLine | IRestockedLine): IRestockFromReturnResultEntry {
    return {
      returnLineId: line.returnLineId,
      variantId: line.variantId,
      stockLocationId: line.stockLocationId,
      quantity: line.quantity,
    };
  }

  private async emitReturned(
    row: IRestockedLine,
    returnRequestId: number,
    correlationId: string,
  ): Promise<void> {
    try {
      await this.publisher.publishStockReturned(
        new StockReturnedEvent({
          variantId: row.variantId,
          stockLocationId: row.stockLocationId,
          quantity: row.quantity,
          returnRequestId,
          returnLineId: row.returnLineId,
        }),
        correlationId,
      );
    } catch (error) {
      this.logger.warn(
        { err: error as Error, correlationId, variantId: row.variantId },
        'Failed to publish inventory.stock.returned (restock already committed)',
      );
    }

    await emitMovementRecorded(this.publisher, this.logger, row.movement, correlationId);
  }
}
