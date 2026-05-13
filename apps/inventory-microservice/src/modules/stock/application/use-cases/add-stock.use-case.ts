import { Inject, Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { EntityManager } from 'typeorm';

import { IStockAppendDeltasPayload, IStockRepositoryPort, STOCK_REPOSITORY } from '../ports';

// Internal-only use case for appending ledger rows directly (e.g. manual
// stock adjustments by ops, future reconciliation jobs). Today it is
// invoked only by `ReserveStockForOrderUseCase`; kept as its own class
// so future call sites (admin endpoints, batch importers) can depend on
// the use case rather than the repository port directly.
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
    entityManager?: EntityManager,
  ): Promise<void> {
    const { items, correlationId } = payload;

    this.logger.debug(
      { correlationId, itemCount: items.length, withinTransaction: !!entityManager },
      'Delegating to stock repository for ledger append',
    );

    return this.repository.appendDeltas(payload, entityManager);
  }
}
