import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { Order } from '../../../common/entities';

@Injectable()
export class OrderGetService {
  constructor(
    @InjectRepository(Order)
    private readonly orderRepository: Repository<Order>,
  ) {}

  public async findById(id: number): Promise<Order> {
    return (await this.orderRepository.findOne({
      where: { id },
      relations: ['products'],
    }))!;
  }
}
