import { Inject, Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';

import { OrderStatusEnum } from '@retail-inventory-system/contracts';

import { IOrderRepositoryPort, ORDER_REPOSITORY } from '../ports';

export interface IOrderHeaderView {
  statusId: OrderStatusEnum;
}

@Injectable()
export class GetOrderUseCase {
  constructor(
    @Inject(ORDER_REPOSITORY)
    private readonly repository: IOrderRepositoryPort,
    @InjectPinoLogger(GetOrderUseCase.name)
    private readonly logger: PinoLogger,
  ) {}

  public async findHeaderById(id: number): Promise<IOrderHeaderView | null> {
    this.logger.debug({ orderId: id }, 'Fetching order header by id');

    const header = await this.repository.findHeaderById(id);

    if (header) {
      this.logger.debug({ orderId: id }, 'Order found');
    } else {
      this.logger.debug({ orderId: id }, 'Order not found');
    }

    return header;
  }
}
