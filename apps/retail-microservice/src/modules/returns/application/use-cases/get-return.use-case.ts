import { Inject, Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';

import { IRetailReturnGetPayload, ReturnRequestView } from '@retail-inventory-system/contracts';

import { IReturnRequestRepositoryPort, RETURN_REQUEST_REPOSITORY } from '../ports';
import { loadOwnedReturn } from './return-access';
import { toReturnRequestView } from './return-view.factory';

// Get Return resolves one RMA (header + lines) by id for the read path. Authorization is
// **owner-or-staff** (ADR-028 §7 / ADR-032), enforced via `loadOwnedReturn`: a customer
// may read an RMA whose order it owns (`request.customerId === actorId`), or a staff caller
// with `order:read` (folded into `isStaff`) may read any. A missing RMA is a 404
// (`RETURN_NOT_FOUND`); a non-owner-non-staff caller a 403 (`RETURN_ACCESS_FORBIDDEN`).
@Injectable()
export class GetReturnUseCase {
  constructor(
    @Inject(RETURN_REQUEST_REPOSITORY)
    private readonly repository: IReturnRequestRepositoryPort,
    @InjectPinoLogger(GetReturnUseCase.name)
    private readonly logger: PinoLogger,
  ) {}

  public async execute(payload: IRetailReturnGetPayload): Promise<ReturnRequestView> {
    const { rmaId, actorId, isStaff, correlationId } = payload;

    this.logger.info({ correlationId, rmaId, actorId, isStaff }, 'Fetching return request');

    const request = await loadOwnedReturn(this.repository, rmaId, actorId, isStaff);
    return toReturnRequestView(request);
  }
}
