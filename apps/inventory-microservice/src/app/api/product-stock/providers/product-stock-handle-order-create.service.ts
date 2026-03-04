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

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  public async execute(event: IOrderCreatedEventPayload): Promise<void> {
    // TODO: RIS-13 Implement order-confirmed event
  }
}
