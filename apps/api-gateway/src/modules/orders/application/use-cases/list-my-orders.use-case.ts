import { Inject, Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';

import { ICurrentUser, IPage, OrderView } from '@retail-inventory-system/contracts';

import { throwRpcError } from '../../../../common/utils';
import { IOrdersGatewayPort, ORDERS_GATEWAY_PORT } from '../ports';

const DEFAULT_PAGE = 1;
const DEFAULT_PAGE_SIZE = 20;

@Injectable()
export class ListMyOrdersUseCase {
  constructor(
    @Inject(ORDERS_GATEWAY_PORT)
    private readonly ordersGateway: IOrdersGatewayPort,
    @InjectPinoLogger(ListMyOrdersUseCase.name)
    private readonly logger: PinoLogger,
  ) {}

  public async execute(
    user: ICurrentUser,
    query: { page?: number; pageSize?: number },
    correlationId: string,
  ): Promise<IPage<OrderView>> {
    this.logger.assign({ correlationId });
    const page = query.page ?? DEFAULT_PAGE;
    const pageSize = query.pageSize ?? DEFAULT_PAGE_SIZE;

    try {
      this.logger.info({ customerId: user.id, page, pageSize }, 'Listing own orders');
      const result = await this.ordersGateway.listMyOrders(
        { customerId: user.id, page, pageSize },
        correlationId,
      );
      this.logger.info({ total: result.total, page: result.page }, 'Own orders listed');
      return result;
    } catch (error) {
      this.logger.error(error, 'Error listing own orders');
      throwRpcError(error);
    }
  }
}
