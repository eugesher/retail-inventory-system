import { Inject, Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';

import { IRetailReturnGetPayload, ReturnRequestView } from '@retail-inventory-system/contracts';

import { IReturnRequestRepositoryPort, RETURN_REQUEST_REPOSITORY } from '../ports';
import { loadOwnedReturn } from './return-access';
import { toReturnRequestView } from './return-view.factory';

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
