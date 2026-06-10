import { Inject, Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';

import { IPage, IRetailOrderListPayload, OrderView } from '@retail-inventory-system/contracts';

import { IOrderRepositoryPort, ORDER_REPOSITORY } from '../ports';
import { toOrderView } from './order-view.factory';

// Sane pagination bounds applied at the use case so a hostile or sloppy page request
// can never ask for an unbounded scan. `page` is 1-based; `pageSize` is clamped to a
// ceiling (the gateway DTO defaults `page`→1 / `pageSize`→20 at the edge, but the use
// case is the binding floor/ceiling).
const DEFAULT_PAGE = 1;
const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;

// List My Orders: the caller's own order history, newest-first (`placed_at DESC`),
// paginated as an `IPage<OrderView>`. It is **own-only** by construction — the only
// identity it carries is `customerId` (the gateway folds in `@CurrentUser().id`), and
// the repository scopes the query to that customer. There is no staff all-orders
// listing here (a later refinement), so unlike Get Order there is no `canReadAny`
// override — a staff member sees only its own orders through this path too.
//
// The list projection carries the full line detail but **omits the per-order
// `payment` row**: folding it in would be one extra query per order (an N+1 on the
// list path). A single-order read (`GetOrderUseCase`) includes the payment; the list
// stays a lean header+lines projection.
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
