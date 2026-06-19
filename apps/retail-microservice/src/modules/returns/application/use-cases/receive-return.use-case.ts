import { Inject, Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';

import { IRetailReturnReceivePayload, ReturnRequestView } from '@retail-inventory-system/contracts';

import { ReturnRequest } from '../../domain';
import {
  IReturnEventsPublisherPort,
  IReturnRequestRepositoryPort,
  RETURN_EVENTS_PUBLISHER,
  RETURN_REQUEST_REPOSITORY,
} from '../ports';
import { loadReturnById } from './return-access';
import { toReturnRequestView } from './return-view.factory';

// Receive Return walks an `authorized` RMA → `received` (warehouse
// `inventory:receive-return`, gated at the gateway) — the warehouse logging in the
// physically-returned goods. The domain `receive()` enforces the legal transition
// (`RETURN_INVALID_STATUS_TRANSITION` from any non-`authorized` start). No per-line
// outcome is recorded here — that is the Inspect step (a later capability). Emits
// `retail.return.received` best-effort post-commit (ADR-020); `receivedAt` is the moment
// the transition ran (the model stamps no dedicated column).
@Injectable()
export class ReceiveReturnUseCase {
  constructor(
    @Inject(RETURN_REQUEST_REPOSITORY)
    private readonly repository: IReturnRequestRepositoryPort,
    @Inject(RETURN_EVENTS_PUBLISHER)
    private readonly publisher: IReturnEventsPublisherPort,
    @InjectPinoLogger(ReceiveReturnUseCase.name)
    private readonly logger: PinoLogger,
  ) {}

  public async execute(payload: IRetailReturnReceivePayload): Promise<ReturnRequestView> {
    const { rmaId, actorId, correlationId } = payload;

    this.logger.info({ correlationId, rmaId, actorId }, 'Receiving return request');

    const request = await loadReturnById(this.repository, rmaId);
    request.receive();
    const saved = await this.repository.save(request);

    await this.emitReceived(saved, correlationId);

    this.logger.info({ correlationId, rmaId, status: saved.status }, 'Return request received');
    return toReturnRequestView(saved);
  }

  private async emitReceived(request: ReturnRequest, correlationId: string): Promise<void> {
    try {
      await this.publisher.publishReturnReceived({
        rmaId: request.id!,
        rmaNumber: request.rmaNumber!,
        orderId: request.orderId,
        customerId: request.customerId,
        receivedAt: new Date().toISOString(),
        eventVersion: 'v1',
        occurredAt: new Date().toISOString(),
        correlationId,
      });
    } catch (error) {
      this.logger.warn(
        { err: error as Error, correlationId, rmaId: request.id },
        'Failed to publish retail.return.received (receive already committed)',
      );
    }
  }
}
