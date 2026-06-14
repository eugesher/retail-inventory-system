import { randomUUID } from 'crypto';

import { Inject, Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';

import {
  IStockTransferPayload,
  IStockTransferResult,
  StockMovementTypeEnum,
} from '@retail-inventory-system/contracts';

import {
  InventoryDomainException,
  InventoryErrorCodeEnum,
  StockLevel,
  StockMovement,
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
import { maybeEmitLowStock } from './low-stock.emitter';
import { emitMovementRecorded } from './movement-recorded.emitter';
import { requireActiveLocation } from './stock-location.guard';
import { runWithStockWriteRetry } from './stock-mutation';
import { toStockLevelView } from './stock-view.factory';

// The two persisted levels + the two ledger rows of a completed transfer, carried
// out of the transaction so the post-commit emits (one recorded event per movement,
// plus the source low-stock re-check) and the result views need no re-query.
interface ITransferred {
  source: StockLevel;
  destination: StockLevel;
  outMovement: StockMovement;
  inMovement: StockMovement;
}

// Transfer Stock moves a positive `quantity` of on-hand for one variant between two
// stock locations, atomically (ADR-030). It is the inventory ledger's last writer:
// every counter-changing inventory operation now leaves a `StockMovement`.
//
// The ledger's type set has **no `transfer` member** — a transfer is modelled as a
// PAIR of `adjustment` movements that share one `referenceType: 'transfer'` +
// `referenceId: <transferId>`: the source leg `quantity = −quantity`
// (`reasonCode: 'transfer-out'`) and the destination leg `quantity = +quantity`
// (`reasonCode: 'transfer-in'`). Reconstructing a transfer is a query for that
// reference pair; the fixed sign-per-type invariant stays intact (adjustment alone
// accepts both signs). In-transit / transfer-order documents are deliberately out
// of scope — a transfer records nothing between the two locations.
//
// Both legs commit in ONE transaction under the shared bounded optimistic write
// protocol: two version-checked `StockLevel` persists + two ledger appends inside
// `withInvalidation(runWithStockWriteRetry(...))`, so a lost compare-and-swap on
// either row rolls the whole attempt back (a retry re-reads both rows fresh and a
// losing attempt leaves no partial state), and the cached availability is wiped
// post-commit for BOTH locations (ADR-023).
//
// A transfer moves **on-hand only** — the source's `quantityReserved` /
// `quantityAllocated` counters are untouched. A transfer that would strand them
// (more than `available` worth of holds left behind) is naturally rejected: the
// source `changeOnHand(−quantity)` throws `STOCK_RESULT_NEGATIVE` (409) the moment
// the move would drive on-hand below zero, before any write.
@Injectable()
export class TransferStockUseCase {
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
    @InjectPinoLogger(TransferStockUseCase.name)
    private readonly logger: PinoLogger,
  ) {}

  public async execute(payload: IStockTransferPayload): Promise<IStockTransferResult> {
    const { variantId, fromLocationId, toLocationId, quantity, actorId, correlationId } = payload;

    this.logger.info(
      { correlationId, variantId, fromLocationId, toLocationId, quantity, actorId },
      'Received RPC: transfer stock',
    );

    // Backstops for the directly-reachable RMQ path — the gateway DTO rejects a
    // non-positive quantity first (a 400 at the edge before the RPC dispatches).
    if (!Number.isInteger(quantity) || quantity <= 0) {
      throw new InventoryDomainException(
        InventoryErrorCodeEnum.TRANSFER_QUANTITY_INVALID,
        `Transfer quantity must be a positive integer, got ${quantity}`,
      );
    }
    // A transfer between identical locations is a no-op that would debit then credit
    // the same row — rejected so the two-leg invariant (two distinct levels) holds.
    if (fromLocationId === toLocationId) {
      throw new InventoryDomainException(
        InventoryErrorCodeEnum.TRANSFER_SAME_LOCATION,
        `Transfer source and destination must differ, both were '${fromLocationId}'`,
      );
    }

    // Both ends must be existing, active locations (the Receive/Adjust guard, run
    // for BOTH legs).
    await requireActiveLocation(this.repository, fromLocationId);
    await requireActiveLocation(this.repository, toLocationId);

    // One pairing key for both ledger rows — a query on `(reference_type='transfer',
    // reference_id=<transferId>)` returns exactly this transfer's two legs.
    const transferId = randomUUID();

    const transferred = await this.stockCache.withInvalidation(
      () =>
        runWithStockWriteRetry(
          { transactionPort: this.transactionPort, logger: this.logger },
          (scope) =>
            this.transferOnce(scope, variantId, fromLocationId, toLocationId, quantity, {
              transferId,
              actorId: actorId ?? null,
            }),
          { variantId, correlationId },
        ),
      // Both `(variantId, location)` pairs (one variant, two facets). A per-variantId
      // prefix wipe already covers both, but passing both makes the intent explicit.
      (result) => [
        { variantId, stockLocationId: result.source.stockLocationId },
        { variantId, stockLocationId: result.destination.stockLocationId },
      ],
      { correlationId },
    );

    this.logger.info(
      {
        correlationId,
        variantId,
        fromLocationId,
        toLocationId,
        quantity,
        transferId,
        sourceOnHand: transferred.source.quantityOnHand,
        destinationOnHand: transferred.destination.quantityOnHand,
      },
      'Stock transferred — on-hand moved between locations',
    );

    // Post-commit, best-effort (ADR-020): announce both ledger inserts, and re-check
    // the source for the low-stock alert (the destination only gained units, so it is
    // never a depletion event). Each leg swallows its own failure and they run
    // concurrently.
    await Promise.all([
      emitMovementRecorded(this.publisher, this.logger, transferred.outMovement, correlationId),
      emitMovementRecorded(this.publisher, this.logger, transferred.inMovement, correlationId),
      maybeEmitLowStock(this.publisher, this.logger, transferred.source, -quantity, correlationId),
    ]);

    return {
      from: toStockLevelView(transferred.source),
      to: toStockLevelView(transferred.destination),
    };
  }

  // One transactional attempt: mutate both levels in memory first (the source debit
  // may throw `STOCK_RESULT_NEGATIVE` before any write), then persist both with their
  // captured optimistic tokens, then append the two paired `adjustment` rows. Re-reads
  // both levels fresh under the scope so a retried attempt never double-applies.
  private async transferOnce(
    scope: ITransactionScope,
    variantId: number,
    fromLocationId: string,
    toLocationId: string,
    quantity: number,
    ledger: { transferId: string; actorId: string | null },
  ): Promise<ITransferred> {
    // Source: load (lazy-init a missing row to zero, whose `changeOnHand(−quantity)`
    // then throws `STOCK_RESULT_NEGATIVE` — the natural empty-source rejection) and
    // debit. Capture the token BEFORE the mutation bumps it; null marks a first-touch.
    const existingSource = await this.repository.findStockLevel(variantId, fromLocationId, scope);
    const sourceExpectedVersion = existingSource ? existingSource.version : null;
    const source = existingSource ?? StockLevel.initialAt(variantId, fromLocationId);
    source.changeOnHand(-quantity);

    // Destination: load / lazy-init and credit (a positive `changeOnHand` never
    // rejects — adding to on-hand cannot go below zero).
    const existingDestination = await this.repository.findStockLevel(
      variantId,
      toLocationId,
      scope,
    );
    const destinationExpectedVersion = existingDestination ? existingDestination.version : null;
    const destination = existingDestination ?? StockLevel.initialAt(variantId, toLocationId);
    destination.changeOnHand(quantity);

    // Both levels validated — persist each once with its captured token, then append
    // the two ledger rows in the same scope (re-read with their DB ids so the
    // post-commit recorded-event emit needs no re-query).
    const savedSource = await this.repository.persistStockLevelChange(
      source,
      sourceExpectedVersion,
      scope,
    );
    const savedDestination = await this.repository.persistStockLevelChange(
      destination,
      destinationExpectedVersion,
      scope,
    );

    const outMovement = await this.movementRepository.append(
      StockMovement.record({
        variantId,
        stockLocationId: fromLocationId,
        type: StockMovementTypeEnum.ADJUSTMENT,
        quantity: -quantity, // the source debit — `adjustment` accepts a negative sign
        reasonCode: 'transfer-out',
        referenceType: 'transfer',
        referenceId: ledger.transferId,
        actorId: ledger.actorId,
      }),
      scope,
    );
    const inMovement = await this.movementRepository.append(
      StockMovement.record({
        variantId,
        stockLocationId: toLocationId,
        type: StockMovementTypeEnum.ADJUSTMENT,
        quantity, // the destination credit — the positive leg of the pair
        reasonCode: 'transfer-in',
        referenceType: 'transfer',
        referenceId: ledger.transferId,
        actorId: ledger.actorId,
      }),
      scope,
    );

    return { source: savedSource, destination: savedDestination, outMovement, inMovement };
  }
}
