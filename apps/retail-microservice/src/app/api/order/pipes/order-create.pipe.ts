import { HttpStatus, Injectable, PipeTransform } from '@nestjs/common';
import { RpcException } from '@nestjs/microservices';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { OrderCreateDto } from '@retail-inventory-system/retail';
import { Customer } from '../../../common/entities';

@Injectable()
export class OrderCreatePipe implements PipeTransform<OrderCreateDto, Promise<OrderCreateDto>> {
  constructor(
    @InjectRepository(Customer)
    private readonly customerRepository: Repository<Customer>,
  ) {}

  public async transform(dto: OrderCreateDto): Promise<OrderCreateDto> {
    const customer = await this.customerRepository.findOne({ where: { id: dto.customerId } });

    if (!customer) {
      throw new RpcException({
        statusCode: HttpStatus.NOT_FOUND,
        message: `Customer #${dto.customerId} not found`,
      });
    }

    return dto;
  }
}
