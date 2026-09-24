import { Inject, Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';

import { IRetailReturnClosePayload, ReturnRequestView } from '@retail-inventory-system/contracts';

import { ReturnRequest } from '../../domain';
import {
  IReturnEventsPublisherPort,
  IReturnRequestRepositoryPort,
  IReturnsUnitOfWorkRunner,
  OCC_RETRY_ATTEMPTS,
  RETURN_EVENTS_PUBLISHER,
  RETURN_REQUEST_REPOSITORY,
  RETURNS_UNIT_OF_WORK,
} from '../ports';
import { loadReturnById } from './return-access';
import { runWithReturnWriteRetry } from './return-write';
import { toReturnRequestView } from './return-view.factory';

@Injectable()
export class CloseReturnUseCase {
  constructor(
    @Inject(RETURN_REQUEST_REPOSITORY)
    private readonly repository: IReturnRequestRepositoryPort,
    @Inject(RETURNS_UNIT_OF_WORK)
    private readonly returnsUow: IReturnsUnitOfWorkRunner,
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

    const saved = await runWithReturnWriteRetry(
      { logger: this.logger, maxAttempts: this.maxAttempts },
      async () => {
        const request = await loadReturnById(this.repository, rmaId);
        const versionAtLoad = request.version;
        request.close(new Date());
        return this.returnsUow.run((uow) => uow.returnRequests.save(request, versionAtLoad));
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
