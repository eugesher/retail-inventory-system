import { HttpStatus, Injectable, PipeTransform } from '@nestjs/common';
import { RpcException } from '@nestjs/microservices';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { IOrderCreatePayload } from '@retail-inventory-system/retail';
import { Customer } from '../../../common/entities';

@Injectable()
export class OrderCreatePipe implements PipeTransform<
  IOrderCreatePayload,
  Promise<IOrderCreatePayload>
> {
  constructor(
    @InjectRepository(Customer)
    private readonly customerRepository: Repository<Customer>,
  ) {}

  public async transform(payload: IOrderCreatePayload): Promise<IOrderCreatePayload> {
    const exists = await this.customerRepository.existsBy({ id: payload.customerId });

    if (!exists) {
      throw new RpcException({
        statusCode: HttpStatus.NOT_FOUND,
        message: `Customer #${payload.customerId} not found`,
      });
    }

    return payload;
  }
}
