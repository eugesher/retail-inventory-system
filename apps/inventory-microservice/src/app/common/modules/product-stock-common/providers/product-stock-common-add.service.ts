import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { EntityManager, Repository } from 'typeorm';

import { ProductStock } from '../../../entities';
import { IProductStockCommonAdd } from '../interfaces';

@Injectable()
export class ProductStockCommonAddService {
  constructor(
    @InjectRepository(ProductStock)
    private readonly productStockRepository: Repository<ProductStock>,
    @InjectPinoLogger(ProductStockCommonAddService.name)
    private readonly logger: PinoLogger,
  ) {}

  public async execute(
    payload: IProductStockCommonAdd,
    entityManager?: EntityManager,
  ): Promise<void> {
    const { items, correlationId } = payload;
    const itemCount = items.length;

    this.logger.debug(
      { correlationId, itemCount, withinTransaction: !!entityManager },
      'Inserting product stock ledger rows',
    );

    const repository = entityManager
      ? entityManager.getRepository(ProductStock)
      : this.productStockRepository;

    try {
      await repository.insert(items);
    } catch (error) {
      this.logger.error(
        { ...error, correlationId, itemCount },
        'Failed to insert product stock ledger rows',
      );

      throw error;
    }

    this.logger.info(
      {
        correlationId,
        itemCount,
        productIds: [...new Set(items.map((i) => i.productId))],
      },
      'Product stock ledger rows inserted',
    );
  }
}
