import { HttpStatus, Injectable, PipeTransform } from '@nestjs/common';
import { RpcException } from '@nestjs/microservices';
import { InjectRepository } from '@nestjs/typeorm';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { DataSource, Repository } from 'typeorm';

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
    private readonly dataSource: DataSource,
    @InjectPinoLogger(OrderCreatePipe.name)
    private readonly logger: PinoLogger,
  ) {}

  public async transform(payload: IOrderCreatePayload): Promise<IOrderCreatePayload> {
    const { customerId, correlationId } = payload;
    const productIds = [...new Set(payload.products.map((p) => p.productId))];

    const [exists, foundProducts] = await Promise.all([
      this.customerRepository.existsBy({ id: customerId }),
      this.dataSource.query<{ id: number }[]>(
        `SELECT id FROM product WHERE id IN (${productIds.map(() => '?').join(',')})`,
        productIds,
      ),
    ]);

    if (!exists) {
      this.logger.warn(
        { correlationId, customerId },
        'Customer not found, rejecting order creation',
      );
      throw new RpcException({
        statusCode: HttpStatus.NOT_FOUND,
        message: `Customer #${customerId} not found`,
      });
    }

    if (foundProducts.length !== productIds.length) {
      this.logger.warn(
        { correlationId, productIds },
        'Invalid product IDs, rejecting order creation',
      );
      throw new RpcException({
        statusCode: HttpStatus.BAD_REQUEST,
        message: 'One or more product IDs are invalid',
      });
    }

    return payload;
  }
}
