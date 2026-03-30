import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { Repository } from 'typeorm';

import { Order } from '../../../common/entities';

@Injectable()
export class OrderGetService {
  constructor(
    @InjectRepository(Order)
    private readonly orderRepository: Repository<Order>,
    @InjectPinoLogger(OrderGetService.name)
    private readonly logger: PinoLogger,
  ) {}

  public async findById(id: number): Promise<Order | null> {
    this.logger.debug({ orderId: id }, 'Fetching order by id');

    const order = await this.orderRepository.findOne({ where: { id } });

    if (order) {
      this.logger.debug({ orderId: id }, 'Order found');
    } else {
      this.logger.debug({ orderId: id }, 'Order not found');
    }

    return order;
  }
}
