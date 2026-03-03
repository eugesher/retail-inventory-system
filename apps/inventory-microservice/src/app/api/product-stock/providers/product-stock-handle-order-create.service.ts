import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { IOrderCreatedEventPayload } from '@retail-inventory-system/retail';
import { ProductStock } from '../../../common/entities';

@Injectable()
export class ProductStockHandleOrderCreateService {
  constructor(
    @InjectRepository(ProductStock)
    private readonly productStockRepository: Repository<ProductStock>,
    private readonly logger: Logger,
  ) {}

  public async execute(event: IOrderCreatedEventPayload): Promise<void> {
    for (const item of event.items) {
      const { productId, quantity, storeId } = item;

      const stock = await this.productStockRepository.findOne({
        where: { productId, storeId: storeId ?? 'default-store' },
      });

      if (!stock || stock.quantity < quantity) {
        this.logger.warn(`Product ${item.productId} not found`);

        return;
      }

      stock.quantity -= quantity;
      await this.productStockRepository.save(stock);
    }

    this.logger.log(`Reserved stock for order ${event.orderId}`);
  }
}
