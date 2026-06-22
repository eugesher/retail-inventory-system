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
  RETURN_CUSTOMER_CONTACT_READER,
  RETURN_EVENTS_PUBLISHER,
  RETURN_REQUEST_REPOSITORY,
} from '../ports';
import { loadReturnById } from './return-access';
import { resolveCustomerEmail } from './resolve-customer-email';
import { toReturnRequestView } from './return-view.factory';

// Authorize Return walks a `requested` RMA → `authorized` (staff `order:return-authorize`,
// gated at the gateway — the use case trusts the gate and only resolves the RMA by id,
// `RETURN_NOT_FOUND` if missing). The domain `authorize(now)` enforces the legal
// transition (`RETURN_INVALID_STATUS_TRANSITION` from any non-`requested` start) and
// stamps `authorizedAt`. A policy re-check (window / condition) is deliberately NOT
// repeated here — the substantive eligibility gate was Open; Authorize is the staff's
// approval of an already-validated request. Emits `retail.return.authorized` best-effort
// post-commit (ADR-020).
@Injectable()
export class AuthorizeReturnUseCase {
  constructor(
    @Inject(RETURN_REQUEST_REPOSITORY)
    private readonly repository: IReturnRequestRepositoryPort,
    @Inject(RETURN_EVENTS_PUBLISHER)
    private readonly publisher: IReturnEventsPublisherPort,
    @Inject(RETURN_CUSTOMER_CONTACT_READER)
    private readonly customerContactReader: IReturnCustomerContactReaderPort,
    @InjectPinoLogger(AuthorizeReturnUseCase.name)
    private readonly logger: PinoLogger,
  ) {}

  public async execute(payload: IRetailReturnAuthorizePayload): Promise<ReturnRequestView> {
    const { rmaId, actorId, correlationId } = payload;

    this.logger.info({ correlationId, rmaId, actorId }, 'Authorizing return request');

    const request = await loadReturnById(this.repository, rmaId);
    request.authorize(new Date());
    const saved = await this.repository.save(request);

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
