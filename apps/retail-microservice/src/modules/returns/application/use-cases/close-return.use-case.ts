import { Inject, Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';

import { IRetailReturnClosePayload, ReturnRequestView } from '@retail-inventory-system/contracts';

import { ReturnRequest } from '../../domain';
import {
  IReturnEventsPublisherPort,
  IReturnRequestRepositoryPort,
  OCC_RETRY_ATTEMPTS,
  RETURN_EVENTS_PUBLISHER,
  RETURN_REQUEST_REPOSITORY,
} from '../ports';
import { loadReturnById } from './return-access';
import { runWithReturnWriteRetry } from './return-write';
import { toReturnRequestView } from './return-view.factory';

// Close Return walks an `inspected` RMA → `closed` (staff `order:return-authorize`, gated
// at the gateway), stamping `closedAt`. The domain `close(now)` enforces the legal transition
// (`RETURN_INVALID_STATUS_TRANSITION` from any non-`inspected` start).
//
// **Closing an RMA moves no money, and triggers nothing that will.** It is the terminal state of
// the *return*, not of the *refund*. `retail.return.closed` is emitted best-effort post-commit
// (ADR-020) onto `retail_queue` and **binds no consumer** — a reserved surface. Settlement is
// manual and deliberate: Inspect records what each line earns (`lineRefundAmountMinor`), the RMA
// view surfaces it, and a staff member issues the money through the orders refund endpoint.
// Contrast Cancel *Order*, which flags the payment and auto-refunds through a consumer. The
// return path has no such loop.
@Injectable()
export class CloseReturnUseCase {
  constructor(
    @Inject(RETURN_REQUEST_REPOSITORY)
    private readonly repository: IReturnRequestRepositoryPort,
    @Inject(RETURN_EVENTS_PUBLISHER)
    private readonly publisher: IReturnEventsPublisherPort,
    @Inject(OCC_RETRY_ATTEMPTS)
    private readonly maxAttempts: number,
    @InjectPinoLogger(CloseReturnUseCase.name)
    private readonly logger: PinoLogger,
  ) {}

  public async execute(payload: IRetailReturnClosePayload): Promise<ReturnRequestView> {
    const { rmaId, actorId, correlationId } = payload;

    this.logger.info({ correlationId, rmaId, actorId }, 'Closing return request');

    // Version-checked CAS under the bounded OCC retry (ADR-036): re-read the RMA afresh
    // each attempt, walk `inspected → closed`, and save with the version pinned. A lost
    // CAS retries; a non-`inspected` start is a terminal domain 409, never retried.
    const saved = await runWithReturnWriteRetry(
      { logger: this.logger, maxAttempts: this.maxAttempts },
      async () => {
        const request = await loadReturnById(this.repository, rmaId);
        const versionAtLoad = request.version;
        request.close(new Date());
        return this.repository.save(request, undefined, versionAtLoad);
      },
      { rmaId, correlationId },
    );

    await this.emitClosed(saved, correlationId);

    this.logger.info({ correlationId, rmaId, status: saved.status }, 'Return request closed');
    return toReturnRequestView(saved);
  }

  private async emitClosed(request: ReturnRequest, correlationId: string): Promise<void> {
    try {
      await this.publisher.publishReturnClosed({
        rmaId: request.id!,
        rmaNumber: request.rmaNumber!,
        orderId: request.orderId,
        customerId: request.customerId,
        closedAt: request.closedAt!.toISOString(),
        eventVersion: 'v1',
        occurredAt: new Date().toISOString(),
        correlationId,
      });
    } catch (error) {
      this.logger.warn(
        { err: error as Error, correlationId, rmaId: request.id },
        'Failed to publish retail.return.closed (close already committed)',
      );
    }
  }
}
