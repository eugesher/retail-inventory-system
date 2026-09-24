import { Inject, Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';

import {
  IRetailReturnAuthorizePayload,
  ReturnRequestView,
} from '@retail-inventory-system/contracts';

import { ReturnRequest } from '../../domain';
import {
  IReturnCustomerContactReaderPort,
  IReturnEventsPublisherPort,
  IReturnRequestRepositoryPort,
  IReturnsUnitOfWorkRunner,
  OCC_RETRY_ATTEMPTS,
  RETURN_CUSTOMER_CONTACT_READER,
  RETURN_EVENTS_PUBLISHER,
  RETURN_REQUEST_REPOSITORY,
  RETURNS_UNIT_OF_WORK,
} from '../ports';
import { loadReturnById } from './return-access';
import { resolveCustomerEmail } from './resolve-customer-email';
import { runWithReturnWriteRetry } from './return-write';
import { toReturnRequestView } from './return-view.factory';

@Injectable()
export class AuthorizeReturnUseCase {
  constructor(
    @Inject(RETURN_REQUEST_REPOSITORY)
    private readonly repository: IReturnRequestRepositoryPort,
    @Inject(RETURNS_UNIT_OF_WORK)
    private readonly returnsUow: IReturnsUnitOfWorkRunner,
    @Inject(RETURN_EVENTS_PUBLISHER)
    private readonly publisher: IReturnEventsPublisherPort,
    @Inject(RETURN_CUSTOMER_CONTACT_READER)
    private readonly customerContactReader: IReturnCustomerContactReaderPort,
    @Inject(OCC_RETRY_ATTEMPTS)
    private readonly maxAttempts: number,
    @InjectPinoLogger(AuthorizeReturnUseCase.name)
    private readonly logger: PinoLogger,
  ) {}

  public async execute(payload: IRetailReturnAuthorizePayload): Promise<ReturnRequestView> {
    const { rmaId, actorId, correlationId } = payload;

    this.logger.info({ correlationId, rmaId, actorId }, 'Authorizing return request');

    const saved = await runWithReturnWriteRetry(
      { logger: this.logger, maxAttempts: this.maxAttempts },
      async () => {
        const request = await loadReturnById(this.repository, rmaId);
        const versionAtLoad = request.version;
        request.authorize(new Date());
        return this.returnsUow.run((uow) => uow.returnRequests.save(request, versionAtLoad));
      },
      { rmaId, correlationId },
    );

    await this.emitAuthorized(saved, correlationId);

    this.logger.info({ correlationId, rmaId, status: saved.status }, 'Return request authorized');
    return toReturnRequestView(saved);
  }

  private async emitAuthorized(request: ReturnRequest, correlationId: string): Promise<void> {
    const customerEmail = await resolveCustomerEmail(
      this.customerContactReader,
      request.customerId,
      this.logger,
      correlationId,
    );
    try {
      await this.publisher.publishReturnAuthorized({
        rmaId: request.id!,
        rmaNumber: request.rmaNumber!,
        orderId: request.orderId,
        customerId: request.customerId,
        customerEmail,
        customerLocale: null,
        authorizedAt: request.authorizedAt!.toISOString(),
        eventVersion: 'v1',
        occurredAt: new Date().toISOString(),
        correlationId,
      });
    } catch (error) {
      this.logger.warn(
        { err: error as Error, correlationId, rmaId: request.id },
        'Failed to publish retail.return.authorized (authorize already committed)',
      );
    }
  }
}
