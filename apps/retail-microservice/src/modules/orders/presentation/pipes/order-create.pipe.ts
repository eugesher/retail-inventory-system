import { HttpStatus, Inject, Injectable, PipeTransform } from '@nestjs/common';
import { RpcException } from '@nestjs/microservices';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';

import { IOrderCreatePayload } from '@retail-inventory-system/contracts';

import { IOrderRepositoryPort, ORDER_REPOSITORY } from '../../application/ports';

// Pre-RPC validator. Confirms the customer exists and every productId
// resolves to a row in `product`. Lives in `presentation/pipes/` rather than
// in `application/` because it operates on the wire payload — it pre-checks
// inputs before the use case sees them so the use case can assume a valid
// shape. Reaches the database via the `ORDER_REPOSITORY` port so no
// `Repository<...>` injection leaks out of `infrastructure/` (ADR-013).
@Injectable()
export class OrderCreatePipe implements PipeTransform<
  IOrderCreatePayload,
  Promise<IOrderCreatePayload>
> {
  constructor(
    @Inject(ORDER_REPOSITORY)
    private readonly orderRepository: IOrderRepositoryPort,
    @InjectPinoLogger(OrderCreatePipe.name)
    private readonly logger: PinoLogger,
  ) {}

  public async transform(payload: IOrderCreatePayload): Promise<IOrderCreatePayload> {
    const { customerId, correlationId } = payload;
    const productIds = [...new Set(payload.products.map((p) => p.productId))];

    const [exists, foundProductIds] = await Promise.all([
      this.orderRepository.customerExists(customerId),
      this.orderRepository.findExistingProductIds(productIds),
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

    if (foundProductIds.length !== productIds.length) {
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
