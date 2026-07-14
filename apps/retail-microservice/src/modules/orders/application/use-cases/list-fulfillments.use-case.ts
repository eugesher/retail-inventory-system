import { Inject, Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';

import { FulfillmentView, IRetailFulfillmentListPayload } from '@retail-inventory-system/contracts';

import {
  FULFILLMENT_REPOSITORY,
  IFulfillmentRepositoryPort,
  IOrderRepositoryPort,
  ORDER_REPOSITORY,
} from '../ports';
import { loadAuthorizedOrder } from './order-access';
import { toFulfillmentView } from './fulfillment-view.factory';

// List Fulfillments: the read backing the order's shipment list — every `Fulfillment`
// for one order, newest-first (`shipped_at DESC, id DESC` via `listByOrderId`). An
// order with no fulfillments resolves to an empty array (a 200, not a 404).
//
// Authorization goes through `loadAuthorizedOrder` (the rule is stated there, once); the override is
// `order:read`. **The order is loaded solely to gate the read** — a fulfillment has no owner of its
// own, so the authorization rule lives on the order it hangs off.
@Injectable()
export class ListFulfillmentsUseCase {
  constructor(
    @Inject(ORDER_REPOSITORY)
    private readonly orderRepository: IOrderRepositoryPort,
    @Inject(FULFILLMENT_REPOSITORY)
    private readonly fulfillmentRepository: IFulfillmentRepositoryPort,
    @InjectPinoLogger(ListFulfillmentsUseCase.name)
    private readonly logger: PinoLogger,
  ) {}

  public async execute(payload: IRetailFulfillmentListPayload): Promise<FulfillmentView[]> {
    const { orderId, actorId, canReadAny, correlationId } = payload;

    this.logger.info({ correlationId, orderId, actorId, canReadAny }, 'Listing fulfillments');

    // Owner-or-staff authorization + existence (404 missing / 403 non-owner-non-staff).
    await loadAuthorizedOrder(this.orderRepository, orderId, actorId, canReadAny);

    const fulfillments = await this.fulfillmentRepository.listByOrderId(orderId);
    return fulfillments.map((fulfillment) => toFulfillmentView(fulfillment));
  }
}
