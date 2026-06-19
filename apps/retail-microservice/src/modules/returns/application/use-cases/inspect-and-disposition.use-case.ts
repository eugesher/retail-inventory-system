import { Inject, Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';

import {
  INVENTORY_DEFAULT_STOCK_LOCATION,
  IRestockFromReturnPayload,
  IRetailReturnInspectPayload,
  ReturnDispositionEnum,
  ReturnRequestView,
} from '@retail-inventory-system/contracts';

import {
  ReturnDomainException,
  ReturnErrorCodeEnum,
  ReturnLine,
  ReturnRequest,
} from '../../domain';
import {
  IInventoryRestockGatewayPort,
  IReturnEventsPublisherPort,
  IReturnOrderReaderPort,
  IReturnRequestRepositoryPort,
  ITransactionPort,
  INVENTORY_RESTOCK_GATEWAY,
  RETURN_EVENTS_PUBLISHER,
  RETURN_ORDER_READER,
  RETURN_REQUEST_REPOSITORY,
  TRANSACTION_PORT,
} from '../ports';
import { loadReturnById } from './return-access';
import { retryThenLogForReplay } from './retry-then-log-for-replay';
import { toReturnRequestView } from './return-view.factory';

// How many times Restock from Return is attempted after the local inspection commit
// before the failure is logged for operator replay. Restock is idempotent on
// `returnRequestId` inventory-side, so a retry never double-credits (ADR-032). Retries are
// immediate (no backoff) — the realistic failure is a transient RMQ hiccup the broker
// recovers from (the `COMMIT_SALE_MAX_ATTEMPTS` precedent).
const RESTOCK_MAX_ATTEMPTS = 3;

// Inspect & Disposition — the warehouse step that records each `ReturnLine`'s outcome and
// closes the RMA's middle (`received → inspected`), then puts the fit-for-resale goods back
// on the shelf (ADR-032). It is the returns context's single cross-service operation: it
// records the per-line condition/disposition/refund-amount locally, advances the status,
// and — for every `restock`-disposition line — calls `inventory.stock.restock-from-return`.
//
// **Authorization is staff `inventory:receive-return`** (gated at the gateway, ADR-024 /
// ADR-028 §7), so the payload carries no owner-check flag — the use case trusts the gate
// and only needs the existence check (the `ReceiveReturnUseCase` precedent). `actorId` is
// the warehouse staff who inspected; it rides the restock RPC so the inventory `return`
// ledger row is attributed.
//
// **Every line must be inspected** (the recommended completeness rule): the payload must
// carry exactly one entry per RMA line, so an `inspected` request never has a half-inspected
// line. An unknown `returnLineId` is `RETURN_LINE_NOT_FOUND` (404); an incomplete or
// duplicated set is `RETURN_INSPECTION_INVALID` (400). The per-line enum/amount validation
// is the domain `ReturnLine.inspect`'s (also `RETURN_INSPECTION_INVALID`); the status walk
// is `ReturnRequest.markInspected`'s (`RETURN_INVALID_STATUS_TRANSITION`, 409 from any
// non-`received` start).
//
// **Ordering** (the cross-cutting consistency rule, the Ship→Commit-Sale parallel,
// ADR-031): the inspection (per-line outcome + the `received → inspected` walk) commits
// **locally first**, in one `TRANSACTION_PORT` scope; the restock runs **after** that
// commit, bounded-retried-then-logged — a remote inventory failure does **not** roll back a
// completed physical inspection, and the restock RPC's `returnRequestId` idempotency makes
// the replay safe. Recording the inspection inside the restock transaction was rejected: it
// would couple a local DB transaction to a remote call. A return with no `restock` lines
// makes **no** inventory call (and no order read).
//
// **Inspect records `lineRefundAmountMinor` but does NOT issue a refund** — the refund is a
// distinct, explicit operation (Issue Refund) that sums these per-line amounts; see the
// `Refund` aggregate in the orders module (ADR-032).
@Injectable()
export class InspectAndDispositionUseCase {
  constructor(
    @Inject(TRANSACTION_PORT)
    private readonly transactionPort: ITransactionPort,
    @Inject(RETURN_REQUEST_REPOSITORY)
    private readonly repository: IReturnRequestRepositoryPort,
    @Inject(RETURN_ORDER_READER)
    private readonly orderReader: IReturnOrderReaderPort,
    @Inject(INVENTORY_RESTOCK_GATEWAY)
    private readonly restockGateway: IInventoryRestockGatewayPort,
    @Inject(RETURN_EVENTS_PUBLISHER)
    private readonly publisher: IReturnEventsPublisherPort,
    @InjectPinoLogger(InspectAndDispositionUseCase.name)
    private readonly logger: PinoLogger,
  ) {}

  public async execute(payload: IRetailReturnInspectPayload): Promise<ReturnRequestView> {
    const { rmaId, actorId, correlationId, lines } = payload;

    this.logger.info(
      { correlationId, rmaId, actorId, lineCount: lines.length },
      'Inspecting return request',
    );

    // Staff-gated at the gateway — only the existence check here (404).
    const request = await loadReturnById(this.repository, rmaId);

    // Validate the inspection set against the RMA's lines BEFORE opening a transaction: an
    // unknown line is a 404, an incomplete/duplicated set a 400. `lineById` holds the
    // pre-loaded aggregate's `ReturnLine` references, so mutating them below mutates the
    // request that gets saved.
    const lineById = new Map<number, ReturnLine>(request.lines.map((line) => [line.id!, line]));
    this.assertInspectionCoversEveryLine(lines, lineById);

    const inspectedAt = new Date();

    // Transactional inspection (the cross-cutting consistency rule): record each line's
    // outcome + walk the status in ONE unit of work. `markInspected` enforces the
    // `received → inspected` transition (409 otherwise) and is reached inside the scope, so
    // a wrong status rolls everything back. `save(scope)` re-persists the root + the lines'
    // newly-set inspection columns and re-reads the graph with concrete ids.
    const saved = await this.transactionPort.runInTransaction<ReturnRequest>(async (scope) => {
      for (const input of lines) {
        lineById.get(input.returnLineId)!.inspect({
          condition: input.condition,
          disposition: input.disposition,
          lineRefundAmountMinor: input.lineRefundAmountMinor,
        });
      }
      request.markInspected();
      return this.repository.save(request, scope);
    });

    // AFTER the local commit: restock the `restock`-disposition lines (the only ones that
    // re-enter sellable inventory). Read off the SAVED aggregate so the line ids are
    // concrete. A no-`restock` return makes no inventory call.
    const restockLines = saved.lines.filter(
      (line) => line.disposition === ReturnDispositionEnum.RESTOCK,
    );
    if (restockLines.length > 0) {
      await this.restockFitForResaleLines(saved, restockLines, actorId, correlationId);
    }

    await this.emitInspected(saved, restockLines.length, inspectedAt, correlationId);

    this.logger.info(
      { correlationId, rmaId, status: saved.status, restockedLineCount: restockLines.length },
      'Return request inspected',
    );
    return toReturnRequestView(saved);
  }

  // The completeness rule: every payload line must reference a real RMA line (404), and
  // every RMA line must be inspected exactly once (400). Pure — runs before any DB write.
  private assertInspectionCoversEveryLine(
    inputLines: IRetailReturnInspectPayload['lines'],
    lineById: Map<number, ReturnLine>,
  ): void {
    for (const input of inputLines) {
      if (!lineById.has(input.returnLineId)) {
        throw new ReturnDomainException(
          ReturnErrorCodeEnum.RETURN_LINE_NOT_FOUND,
          `Return line ${input.returnLineId} is not part of this return request`,
        );
      }
    }

    const inspectedIds = new Set(inputLines.map((input) => input.returnLineId));
    if (inspectedIds.size !== inputLines.length) {
      throw new ReturnDomainException(
        ReturnErrorCodeEnum.RETURN_INSPECTION_INVALID,
        'Each return line may be inspected only once',
      );
    }
    for (const lineId of lineById.keys()) {
      if (!inspectedIds.has(lineId)) {
        throw new ReturnDomainException(
          ReturnErrorCodeEnum.RETURN_INSPECTION_INVALID,
          `Inspection must cover every line; line ${lineId} was not inspected`,
        );
      }
    }
  }

  // Builds the restock payload from the `restock`-disposition lines and calls the inventory
  // RPC, bounded-retried-then-logged. The receiving location defaults to the default
  // warehouse (a per-line location override is out of scope — the return arrives at the
  // warehouse). The variant for each line is resolved from the order via the raw-SQL reader
  // (a `ReturnLine` carries only `orderLineId`, never the variant). Never throws — the
  // inspection is already committed (ADR-032).
  private async restockFitForResaleLines(
    request: ReturnRequest,
    restockLines: readonly ReturnLine[],
    actorId: string,
    correlationId: string,
  ): Promise<void> {
    const snapshot = await this.orderReader.findOrderForReturn(request.orderId);
    if (!snapshot) {
      // The RMA references a real order (FK), so a missing snapshot is an invariant breach
      // — log for replay rather than throw (the inspection has committed).
      this.logger.error(
        { correlationId, rmaId: request.id, orderId: request.orderId },
        'Restock-from-Return skipped: order snapshot not found (inspection committed; awaits operator replay)',
      );
      return;
    }
    const variantByOrderLine = new Map(
      snapshot.lines.map((line) => [line.orderLineId, line.variantId]),
    );

    const payload: IRestockFromReturnPayload = {
      returnRequestId: request.id!,
      lines: restockLines.map((line) => ({
        returnLineId: line.id!,
        variantId: variantByOrderLine.get(line.orderLineId)!,
        stockLocationId: INVENTORY_DEFAULT_STOCK_LOCATION,
        quantity: line.quantity,
      })),
      actorId,
      correlationId,
    };

    await retryThenLogForReplay(() => this.restockGateway.restockFromReturn(payload), {
      maxAttempts: RESTOCK_MAX_ATTEMPTS,
      logger: this.logger,
      correlationId,
      label: 'Restock-from-Return',
      context: { returnRequestId: payload.returnRequestId, lines: payload.lines },
      replayMessage:
        'Restock-from-Return failed after retries; the inspection is committed and the restock awaits operator replay (idempotent on returnRequestId)',
    });
  }

  // Best-effort post-commit emit (ADR-020). The inspection has already committed, so a
  // publish failure is warn-logged and swallowed. `restockedLineCount` lets a downstream
  // tell a refund-only inspection from one that returned goods to the shelf.
  private async emitInspected(
    request: ReturnRequest,
    restockedLineCount: number,
    inspectedAt: Date,
    correlationId: string,
  ): Promise<void> {
    try {
      await this.publisher.publishReturnInspected({
        rmaId: request.id!,
        rmaNumber: request.rmaNumber!,
        orderId: request.orderId,
        customerId: request.customerId,
        inspectedAt: inspectedAt.toISOString(),
        restockedLineCount,
        eventVersion: 'v1',
        occurredAt: new Date().toISOString(),
        correlationId,
      });
    } catch (error) {
      this.logger.warn(
        { err: error as Error, correlationId, rmaId: request.id },
        'Failed to publish retail.return.inspected (inspection already committed)',
      );
    }
  }
}
