import { HttpStatus, Injectable, PipeTransform } from '@nestjs/common';
import { RpcException } from '@nestjs/microservices';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { IOrderConfirm, IOrderConfirmPayload } from '@retail-inventory-system/retail';
import { Order } from '../../../common/entities';

@Injectable()
export class OrderConfirmPipe implements PipeTransform<
  IOrderConfirmPayload,
  Promise<IOrderConfirm>
> {
  constructor(
    @InjectRepository(Order)
    private readonly orderRepository: Repository<Order>,
  ) {}

  public async transform(payload: IOrderConfirmPayload): Promise<IOrderConfirm> {
    const { id, correlationId } = payload;

    const order = await this.orderRepository
      .createQueryBuilder('Order')
      .leftJoin('Order.products', 'OrderProduct')
      .select(['Order.id', 'OrderProduct.id', 'OrderProduct.productId', 'OrderProduct.statusId'])
      .where('Order.id = :id', { id })
      .getOne();

    if (!order) {
      throw new RpcException({
        statusCode: HttpStatus.NOT_FOUND,
        message: `Order #${id} not found`,
      });
    }

    return { ...order, correlationId };
  }
}
