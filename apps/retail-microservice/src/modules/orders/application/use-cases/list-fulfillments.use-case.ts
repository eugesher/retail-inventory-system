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
// **Authorization is owner-or-staff `order:read`** (ADR-024 / ADR-028 §7), enforced
// here via `loadAuthorizedOrder`: allow if `canReadAny` (the gateway already confirmed
// the caller carries `order:read`) **or** `order.customerId === actorId` (the owning
// customer) — else `ORDER_ACCESS_FORBIDDEN` (403); a missing order is 404. The order
// is loaded only to gate the read — the authorization rule lives on the order, the
// fulfillments hang off it.
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
