import { Inject, Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';

import { IPage, IRetailOrderListPayload, OrderView } from '@retail-inventory-system/contracts';

import { IOrderRepositoryPort, ORDER_REPOSITORY } from '../ports';
import { toOrderView } from './order-view.factory';

const DEFAULT_PAGE = 1;
const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;

@Injectable()
export class ListMyOrdersUseCase {
  constructor(
    @Inject(ORDER_REPOSITORY)
    private readonly orderRepository: IOrderRepositoryPort,
    @InjectPinoLogger(ListMyOrdersUseCase.name)
    private readonly logger: PinoLogger,
  ) {}

  public async execute(payload: IRetailOrderListPayload): Promise<IPage<OrderView>> {
    const { customerId, correlationId } = payload;
    const page = Number.isInteger(payload.page) && payload.page > 0 ? payload.page : DEFAULT_PAGE;
    const size = ListMyOrdersUseCase.clampPageSize(payload.pageSize);

    this.logger.info({ correlationId, customerId, page, size }, 'Listing own orders');

    const result = await this.orderRepository.listByCustomer(customerId, { page, size });

    return {
      items: result.items.map((order) => toOrderView(order)),
      total: result.total,
      page: result.page,
      size: result.size,
    };
  }

  private static clampPageSize(requested: number): number {
    if (!Number.isInteger(requested) || requested <= 0) {
      return DEFAULT_PAGE_SIZE;
    }
    return Math.min(requested, MAX_PAGE_SIZE);
  }
}
