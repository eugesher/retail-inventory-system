import { Inject, Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';

import { IRetailReturnClosePayload, ReturnRequestView } from '@retail-inventory-system/contracts';

import { ReturnRequest } from '../../domain';
import {
  IReturnEventsPublisherPort,
  IReturnRequestRepositoryPort,
  RETURN_EVENTS_PUBLISHER,
  RETURN_REQUEST_REPOSITORY,
} from '../ports';
import { loadReturnById } from './return-access';
import { toReturnRequestView } from './return-view.factory';

// Close Return walks an `inspected` RMA → `closed` (staff `order:return-authorize`, gated
// at the gateway) — the terminal settlement of the RMA, stamping `closedAt`. The domain
// `close(now)` enforces the legal transition (`RETURN_INVALID_STATUS_TRANSITION` from any
// non-`inspected` start). The actual refund, when money is owed, is issued by the later
// refund capability (which consumes the `retail.return.closed` event); this use case only
// closes the RMA. Emits `retail.return.closed` onto `retail_queue` (reserved) best-effort
// post-commit (ADR-020).
@Injectable()
export class CloseReturnUseCase {
  constructor(
    @Inject(RETURN_REQUEST_REPOSITORY)
    private readonly repository: IReturnRequestRepositoryPort,
    @Inject(RETURN_EVENTS_PUBLISHER)
    private readonly publisher: IReturnEventsPublisherPort,
    @InjectPinoLogger(CloseReturnUseCase.name)
    private readonly logger: PinoLogger,
  ) {}

  public async execute(payload: IRetailReturnClosePayload): Promise<ReturnRequestView> {
    const { rmaId, actorId, correlationId } = payload;

    this.logger.info({ correlationId, rmaId, actorId }, 'Closing return request');

    const request = await loadReturnById(this.repository, rmaId);
    request.close(new Date());
    const saved = await this.repository.save(request);

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
