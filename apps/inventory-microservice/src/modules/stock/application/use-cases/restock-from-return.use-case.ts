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
  OCC_RETRY_ATTEMPTS,
  STOCK_CACHE,
  STOCK_EVENTS_PUBLISHER,
  STOCK_MOVEMENT_REPOSITORY,
  STOCK_REPOSITORY,
  TRANSACTION_PORT,
} from '../ports';
import { LedgerReplayError } from './ledger-replay.error';
import { emitMovementRecorded } from './movement-recorded.emitter';
import { isDuplicateEntryError } from './mysql-error.util';
import {
  INormalizedReservationLine,
  levelKey,
  loadDistinctLevels,
  requireDistinctLevels,
} from './reservation-mutation';
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

// The mirror of Commit Sale (ADR-032). Per line it puts units back into `quantity_on_hand` and
// appends a strictly-positive `return` movement. Reserved and allocated are untouched, so
// `available` rises by the full amount — a returned unit is immediately sellable again.
//
// **Only `restock`-disposition lines reach here.** Goods scrapped or quarantined at inspection came
// back to the warehouse but never to the shelf, and inventory never hears about them at all.
//
// **Idempotent on `returnRequestId`, including against CONCURRENT redeliveries**: retail drives this
// **after** its own inspect transaction has committed, so a transient RMQ failure re-delivers a
// request whose work is already durable — and the broker never promises the redelivery waits for the
// original. Two mechanisms, in that order: the `existsByReference` probe short-circuits the
// sequential replay, and `UC_STOCK_MOVEMENT_DEDUPE` — a UNIQUE on the ledger — holds when two
// deliveries are in flight at once. **The probe is an optimisation; the constraint is the
// guarantee.** One Inspect → one restock RPC per return, so per-request idempotency is the right
// grain (the Commit Sale `fulfillmentId` precedent).
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
    @Inject(OCC_RETRY_ATTEMPTS)
    private readonly maxAttempts: number,
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
    // Two lines on one level would collide on `UC_STOCK_MOVEMENT_DEDUPE` and the catch
    // below would misread the collision as a replay — see `requireDistinctLevels`.
    requireDistinctLevels(lines, 'Restock from return');
    const referenceId = String(returnRequestId);

    // The FAST PATH, not the guard (ADR-032). A `return` movement already referencing
    // this return request means the restock happened — re-return the request's lines
    // WITHOUT incrementing again, skipping `withInvalidation` entirely because nothing
    // changed.
    //
    // **It runs outside the write transaction, so it cannot serialise two CONCURRENT
    // deliveries** — both would read "not yet restocked" and both would credit the
    // stock. What makes this idempotent is `UC_STOCK_MOVEMENT_DEDUPE` (migration
    // `1783872387242`), caught below. The probe survives as the cheap short-circuit for
    // the sequential replay, which is the common case.
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

    let outcome: IRestockOutcome;
    try {
      outcome = await this.stockCache.withInvalidation(
        () =>
          runWithStockWriteRetry(
            {
              transactionPort: this.transactionPort,
              logger: this.logger,
              maxAttempts: this.maxAttempts,
            },
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
    } catch (error) {
      // THE GUARD — the inverted twin of Commit Sale's, in the same two forms: we either
      // SAW the winner's `return` row under our own snapshot (`LedgerReplayError`) or
      // broke `UC_STOCK_MOVEMENT_DEDUPE` on the INSERT. Either way the transaction rolled
      // back and this attempt incremented nothing.
      //
      // The stakes are the mirror image of Commit Sale's: an uncaught double-credit
      // invents stock that never came back, and phantom inventory OVERSELLS. It also
      // must not rethrow — an exception out of an `@MessagePattern` is blind-redelivered
      // by the broker in a hot loop.
      if (error instanceof LedgerReplayError || isDuplicateEntryError(error)) {
        this.logger.info(
          { correlationId, returnRequestId },
          'Restock lost a concurrent race — the ledger already holds this return request, nothing incremented',
        );
        return { restocked: lines.map((line) => this.toEntry(line)) };
      }
      throw error;
    }

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
    // Phase 0 — re-probe UNDER THE SCOPE (the Commit Sale protocol; see
    // `LedgerReplayError`). Restock has no counter that would trip on a winner's commit
    // the way `StockLevel.commitSale`'s drift check does — `changeOnHand(+q)` never
    // rejects — so a loser reaching phase 3 would be caught by `UC_STOCK_MOVEMENT_DEDUPE`
    // anyway. This probe still earns its place: it unwinds the loser BEFORE it performs a
    // level write that is only going to roll back, and it keeps the two ledger-deduped
    // use cases telling one story rather than two.
    const referenceIdProbe = String(returnRequestId);
    if (
      await this.movementRepository.existsByReference(
        RETURN_REQUEST_REFERENCE_TYPE,
        referenceIdProbe,
        scope,
      )
    ) {
      throw new LedgerReplayError(RETURN_REQUEST_REFERENCE_TYPE, referenceIdProbe);
    }

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
