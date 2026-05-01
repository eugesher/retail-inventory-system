import { Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { EntityManager } from 'typeorm';

import { IProductStockCommonAdd } from './interfaces';
import { ProductStockCommonAddService } from './providers';

@Injectable()
export class ProductStockCommonService {
  constructor(
    private readonly productStockCommonAddService: ProductStockCommonAddService,
    @InjectPinoLogger(ProductStockCommonService.name)
    private readonly logger: PinoLogger,
  ) {}

  public async add(payload: IProductStockCommonAdd, entityManager?: EntityManager): Promise<void> {
    const { items, correlationId } = payload;

    this.logger.debug(
      { correlationId, itemCount: items.length, withinTransaction: !!entityManager },
      'Delegating to ProductStockCommonAddService',
    );

    return await this.productStockCommonAddService.execute(payload, entityManager);
  }
}
