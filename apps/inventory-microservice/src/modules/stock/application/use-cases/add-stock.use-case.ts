import { Inject, Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';

import {
  IStockAppendDeltasPayload,
  IStockRepositoryPort,
  ITransactionScope,
  STOCK_REPOSITORY,
} from '../ports';

@Injectable()
export class AddStockUseCase {
  constructor(
    @Inject(STOCK_REPOSITORY)
    private readonly repository: IStockRepositoryPort,
    @InjectPinoLogger(AddStockUseCase.name)
    private readonly logger: PinoLogger,
  ) {}

  public async execute(
    payload: IStockAppendDeltasPayload,
    scope?: ITransactionScope,
  ): Promise<void> {
    const { items, correlationId } = payload;

    this.logger.debug(
      { correlationId, itemCount: items.length, withinTransaction: !!scope },
      'Delegating to stock repository for ledger append',
    );

    return this.repository.appendDeltas(payload, scope);
  }
}
