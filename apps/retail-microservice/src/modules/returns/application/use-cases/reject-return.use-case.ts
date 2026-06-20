import { Inject, Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';

import { IRetailReturnRejectPayload, ReturnRequestView } from '@retail-inventory-system/contracts';

import { ReturnRequest } from '../../domain';
import {
  IReturnEventsPublisherPort,
  IReturnRequestRepositoryPort,
  RETURN_EVENTS_PUBLISHER,
  RETURN_REQUEST_REPOSITORY,
} from '../ports';
import { loadReturnById } from './return-access';
import { toReturnRequestView } from './return-view.factory';

// Reject Return walks a `requested` RMA → `rejected` (staff `order:return-authorize`,
// gated at the gateway). Rejection is terminal and stamps `closedAt`. The optional
// `reason` is recorded by appending it to the RMA's `notes` (the domain `reject(at,
// reason)` does the append) — keeping it in `notes` avoids a schema change (ADR-032); the
// reason also rides the `retail.return.rejected` event. The domain enforces the legal
// transition (`RETURN_INVALID_STATUS_TRANSITION` from any non-`requested` start). Emits
// `retail.return.rejected` onto `retail_queue` (reserved) best-effort post-commit
// (ADR-020).
@Injectable()
export class RejectReturnUseCase {
  constructor(
    @Inject(RETURN_REQUEST_REPOSITORY)
    private readonly repository: IReturnRequestRepositoryPort,
    @Inject(RETURN_EVENTS_PUBLISHER)
    private readonly publisher: IReturnEventsPublisherPort,
    @InjectPinoLogger(RejectReturnUseCase.name)
    private readonly logger: PinoLogger,
  ) {}

  public async execute(payload: IRetailReturnRejectPayload): Promise<ReturnRequestView> {
    const { rmaId, reason, actorId, correlationId } = payload;

    this.logger.info({ correlationId, rmaId, actorId }, 'Rejecting return request');

    const request = await loadReturnById(this.repository, rmaId);
    request.reject(new Date(), reason ?? null);
    const saved = await this.repository.save(request);

    await this.emitRejected(saved, reason ?? null, correlationId);

    this.logger.info({ correlationId, rmaId, status: saved.status }, 'Return request rejected');
    return toReturnRequestView(saved);
  }

  private async emitRejected(
    request: ReturnRequest,
    reason: string | null,
    correlationId: string,
  ): Promise<void> {
    try {
      await this.publisher.publishReturnRejected({
        rmaId: request.id!,
        rmaNumber: request.rmaNumber!,
        orderId: request.orderId,
        customerId: request.customerId,
        closedAt: request.closedAt!.toISOString(),
        reason,
        eventVersion: 'v1',
        occurredAt: new Date().toISOString(),
        correlationId,
      });
    } catch (error) {
      this.logger.warn(
        { err: error as Error, correlationId, rmaId: request.id },
        'Failed to publish retail.return.rejected (reject already committed)',
      );
    }
  }
}
