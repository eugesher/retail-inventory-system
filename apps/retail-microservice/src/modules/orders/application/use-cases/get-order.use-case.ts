import { Inject, Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';

import { OrderStatusEnum } from '@retail-inventory-system/contracts';

import { IOrderRepositoryPort, ORDER_REPOSITORY } from '../ports';

// The API gateway's `OrderConfirmPipe` only needs the order header status
// today (it short-circuits a non-PENDING confirm with a 400 before sending
// the full RPC). Returning just `{ statusId }` keeps the wire payload small
// and matches the gateway-side port shape verbatim.
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
