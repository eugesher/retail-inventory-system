import { Inject, Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';

import {
  IRetailReturnOpenPayload,
  OrderFulfillmentStatusEnum,
  ReturnRequestView,
  ReturnStatusEnum,
} from '@retail-inventory-system/contracts';

import { ReturnDomainException, ReturnErrorCodeEnum, ReturnRequest } from '../../domain';
import {
  IReturnCustomerContactReaderPort,
  IReturnEventsPublisherPort,
  IReturnOrderReaderPort,
  IReturnOrderSnapshot,
  IReturnRequestRepositoryPort,
  IReturnsUnitOfWorkRunner,
  RETURN_CUSTOMER_CONTACT_READER,
  RETURN_EVENTS_PUBLISHER,
  RETURN_ORDER_READER,
  RETURN_REQUEST_REPOSITORY,
  RETURN_WINDOW_DAYS,
  RETURNS_UNIT_OF_WORK,
} from '../ports';
import { resolveCustomerEmail } from './resolve-customer-email';
import { toReturnRequestView } from './return-view.factory';

const MS_PER_DAY = 24 * 60 * 60 * 1000;

@Injectable()
export class OpenReturnRequestUseCase {
  constructor(
    @Inject(RETURN_REQUEST_REPOSITORY)
    private readonly repository: IReturnRequestRepositoryPort,
    @Inject(RETURNS_UNIT_OF_WORK)
    private readonly returnsUow: IReturnsUnitOfWorkRunner,
    @Inject(RETURN_ORDER_READER)
    private readonly orderReader: IReturnOrderReaderPort,
    @Inject(RETURN_EVENTS_PUBLISHER)
    private readonly publisher: IReturnEventsPublisherPort,
    @Inject(RETURN_CUSTOMER_CONTACT_READER)
    private readonly customerContactReader: IReturnCustomerContactReaderPort,
    @Inject(RETURN_WINDOW_DAYS)
    private readonly returnWindowDays: number,
    @InjectPinoLogger(OpenReturnRequestUseCase.name)
    private readonly logger: PinoLogger,
  ) {}

  public async execute(payload: IRetailReturnOpenPayload): Promise<ReturnRequestView> {
    const { orderId, customerId, isStaff, reasonCategory, notes, lines, correlationId } = payload;
    const now = new Date();

    this.logger.info(
      { correlationId, orderId, customerId, isStaff, lineCount: lines.length },
      'Opening return request',
    );

    const order = await this.orderReader.findOrderForReturn(orderId);
    if (!order) {
      throw new ReturnDomainException(
        ReturnErrorCodeEnum.RETURN_ORDER_NOT_FOUND,
        `Order ${orderId} not found for return`,
      );
    }

    if (!isStaff && order.customerId !== customerId) {
      throw new ReturnDomainException(
        ReturnErrorCodeEnum.RETURN_ACCESS_FORBIDDEN,
        `Order ${orderId} is not accessible to actor ${customerId}`,
      );
    }

    this.assertWithinReturnWindow(order, now);

    const alreadyReturned = await this.sumAlreadyReturnedByLine(orderId);
    const orderLineById = new Map(order.lines.map((l) => [l.orderLineId, l]));
    for (const requestedLine of lines) {
      const orderLine = orderLineById.get(requestedLine.orderLineId);
      if (!orderLine) {
        throw new ReturnDomainException(
          ReturnErrorCodeEnum.RETURN_ORDER_LINE_NOT_FOUND,
          `Order line ${requestedLine.orderLineId} does not belong to order ${orderId}`,
        );
      }
      const alreadyReturnedQty = alreadyReturned.get(requestedLine.orderLineId) ?? 0;
      const returnable = orderLine.quantity - orderLine.cancelledQuantity - alreadyReturnedQty;
      if (requestedLine.quantity > returnable) {
        throw new ReturnDomainException(
          ReturnErrorCodeEnum.RETURN_QUANTITY_EXCEEDS_RETURNABLE,
          `Order line ${requestedLine.orderLineId}: cannot return ${requestedLine.quantity} of the ${returnable} returnable (ordered ${orderLine.quantity}, cancelled ${orderLine.cancelledQuantity}, already returned ${alreadyReturnedQty})`,
        );
      }
    }

    const request = ReturnRequest.open(
      {
        orderId,
        customerId: order.customerId ?? customerId,
        reasonCategory,
        notes: notes ?? null,
        lines,
      },
      now,
    );
    const saved = await this.returnsUow.run((uow) => uow.returnRequests.save(request));

    await this.emitRequested(saved, correlationId);

    this.logger.info(
      { correlationId, orderId, rmaId: saved.id, rmaNumber: saved.rmaNumber },
      'Return request opened',
    );
    return toReturnRequestView(saved);
  }

  private assertWithinReturnWindow(order: IReturnOrderSnapshot, now: Date): void {
    if (order.fulfillmentStatus === OrderFulfillmentStatusEnum.DELIVERED) {
      return;
    }
    if (
      order.fulfillmentStatus === OrderFulfillmentStatusEnum.SHIPPED ||
      order.fulfillmentStatus === OrderFulfillmentStatusEnum.PARTIALLY_SHIPPED
    ) {
      const shippedFrom = order.shippedAt ?? order.deliveredAt;
      if (!shippedFrom) {
        throw new ReturnDomainException(
          ReturnErrorCodeEnum.RETURN_ORDER_NOT_RETURNABLE,
          `Order ${order.orderId} reports shipped but carries no ship date`,
        );
      }
      const deadline = shippedFrom.getTime() + this.returnWindowDays * MS_PER_DAY;
      if (now.getTime() > deadline) {
        throw new ReturnDomainException(
          ReturnErrorCodeEnum.RETURN_WINDOW_EXPIRED,
          `Order ${order.orderId} is past its ${this.returnWindowDays}-day return window (shipped ${shippedFrom.toISOString()})`,
        );
      }
      return;
    }
    throw new ReturnDomainException(
      ReturnErrorCodeEnum.RETURN_ORDER_NOT_RETURNABLE,
      `Order ${order.orderId} is not in a returnable state (fulfillment: ${order.fulfillmentStatus})`,
    );
  }

  private async sumAlreadyReturnedByLine(orderId: number): Promise<Map<number, number>> {
    const existing = await this.repository.listByOrderId(orderId);
    const byLine = new Map<number, number>();
    for (const rma of existing) {
      if (rma.status === ReturnStatusEnum.REJECTED) {
        continue;
      }
      for (const line of rma.lines) {
        byLine.set(line.orderLineId, (byLine.get(line.orderLineId) ?? 0) + line.quantity);
      }
    }
    return byLine;
  }

  private async emitRequested(request: ReturnRequest, correlationId: string): Promise<void> {
    const customerEmail = await resolveCustomerEmail(
      this.customerContactReader,
      request.customerId,
      this.logger,
      correlationId,
    );
    try {
      await this.publisher.publishReturnRequested({
        rmaId: request.id!,
        rmaNumber: request.rmaNumber!,
        orderId: request.orderId,
        customerId: request.customerId,
        customerEmail,
        customerLocale: null,
        requestedAt: request.requestedAt.toISOString(),
        lineCount: request.lines.length,
        eventVersion: 'v1',
        occurredAt: new Date().toISOString(),
        correlationId,
      });
    } catch (error) {
      this.logger.warn(
        { err: error as Error, correlationId, rmaId: request.id },
        'Failed to publish retail.return.requested (return already opened)',
      );
    }
  }
}
