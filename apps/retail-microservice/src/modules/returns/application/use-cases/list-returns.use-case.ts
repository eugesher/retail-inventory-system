import { Inject, Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';

import { IRetailReturnListPayload, ReturnRequestView } from '@retail-inventory-system/contracts';

import { ReturnDomainException, ReturnErrorCodeEnum } from '../../domain';
import {
  IReturnOrderReaderPort,
  IReturnRequestRepositoryPort,
  RETURN_ORDER_READER,
  RETURN_REQUEST_REPOSITORY,
} from '../ports';
import { toReturnRequestView } from './return-view.factory';

// List Returns For Order resolves one order's RMAs newest-first (the repository orders by
// `requested_at DESC, id DESC`). Authorization is **owner-or-staff** (ADR-028 §7 / ADR-032): staff
// with `order:read` (folded into `isStaff`) see every RMA; the buying customer sees the order's RMAs;
// **anyone else is REFUSED with a 403** (ADR-051). An order with no RMAs resolves to an empty array.
//
// **The owner check runs against the ORDER, not against the RMA rows** — and that distinction is the
// whole point of ADR-051. This use case used to filter the fetched RMAs by `customerId`, handing a
// non-owner an empty list. Two things were wrong with it. It disagreed with every other ownership
// check in the system (`list-refunds`, `list-fulfillments` and the two shared access helpers all
// throw 403), so a client needed two error handlers for one shape of request. And the "no existence
// leak" it claimed to buy **was not bought**: an order with no RMAs returned `[]` and an order with
// RMAs returned `[]` too — but only because the rows were filtered, so the endpoint still answered
// *"does this order have returns?"* to a caller who may not know the order exists, while `GET
// /orders/:id/refunds` confirmed the order's existence outright one route over.
//
// So: load the order, refuse, then list. `RETURN_ORDER_READER` is how — the returns module may not
// import `orders/` (ADR-032), and this is the same seam Open already authorizes through. It returns
// the order header **and its lines** (it is shaped for Open's returnable-quantity math), so this list
// pays for a projection wider than it needs; that is one indexed read on a read path, and judged
// cheaper than a second port method onto the same table.
@Injectable()
export class ListReturnsForOrderUseCase {
  constructor(
    @Inject(RETURN_REQUEST_REPOSITORY)
    private readonly repository: IReturnRequestRepositoryPort,
    @Inject(RETURN_ORDER_READER)
    private readonly orderReader: IReturnOrderReaderPort,
    @InjectPinoLogger(ListReturnsForOrderUseCase.name)
    private readonly logger: PinoLogger,
  ) {}

  public async execute(payload: IRetailReturnListPayload): Promise<ReturnRequestView[]> {
    const { orderId, actorId, isStaff, correlationId } = payload;

    this.logger.info({ correlationId, orderId, actorId, isStaff }, 'Listing returns for order');

    const order = await this.orderReader.findOrderForReturn(orderId);
    if (order === null) {
      throw new ReturnDomainException(
        ReturnErrorCodeEnum.RETURN_ORDER_NOT_FOUND,
        `Order ${orderId} not found`,
      );
    }
    // A tombstoned customer leaves `order.customerId` null (ADR-037), which no `actorId` matches —
    // so an erased order's RMAs are staff-only, which is the intended end state.
    if (!isStaff && order.customerId !== actorId) {
      throw new ReturnDomainException(
        ReturnErrorCodeEnum.RETURN_ACCESS_FORBIDDEN,
        `Returns for order ${orderId} are not accessible to actor ${actorId}`,
      );
    }

    const requests = await this.repository.listByOrderId(orderId);
    return requests.map((request) => toReturnRequestView(request));
  }
}
