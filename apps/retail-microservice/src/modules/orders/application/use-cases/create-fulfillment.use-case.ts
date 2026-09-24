import { Inject, Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';

import {
  FulfillmentView,
  INVENTORY_DEFAULT_STOCK_LOCATION,
  IRetailFulfillmentCreatePayload,
  OrderPaymentStatusEnum,
  OrderStatusEnum,
} from '@retail-inventory-system/contracts';

import { Fulfillment, Order, OrderDomainException, OrderErrorCodeEnum } from '../../domain';
import {
  FULFILLMENT_REPOSITORY,
  IFulfillmentRepositoryPort,
  IOrderEventsPublisherPort,
  IOrderRepositoryPort,
  ORDER_EVENTS_PUBLISHER,
  ORDER_REPOSITORY,
} from '../ports';
import { countsTowardFulfilled, sumLineQuantitiesByOrderLine } from './fulfillment-quantities';
import { loadAuthorizedOrder } from './order-access';
import { toFulfillmentView } from './fulfillment-view.factory';

@Injectable()
export class CreateFulfillmentUseCase {
  constructor(
    @Inject(ORDER_REPOSITORY)
    private readonly orderRepository: IOrderRepositoryPort,
    @Inject(FULFILLMENT_REPOSITORY)
    private readonly fulfillmentRepository: IFulfillmentRepositoryPort,
    @Inject(ORDER_EVENTS_PUBLISHER)
    private readonly publisher: IOrderEventsPublisherPort,
    @InjectPinoLogger(CreateFulfillmentUseCase.name)
    private readonly logger: PinoLogger,
  ) {}

  public async execute(payload: IRetailFulfillmentCreatePayload): Promise<FulfillmentView> {
    const { orderId, stockLocationId, lines, actorId, isStaffFulfill, correlationId } = payload;

    this.logger.info(
      { correlationId, orderId, actorId, isStaffFulfill, lineCount: lines.length },
      'Creating fulfillment',
    );

    const order = await loadAuthorizedOrder(this.orderRepository, orderId, actorId, isStaffFulfill);

    CreateFulfillmentUseCase.assertFulfillable(order);

    await this.assertWithinRemaining(order, lines);

    const fulfillment = Fulfillment.create({
      orderId,
      stockLocationId: stockLocationId ?? INVENTORY_DEFAULT_STOCK_LOCATION,
      lines: lines.map((line) => ({ orderLineId: line.orderLineId, quantity: line.quantity })),
    });
    const saved = await this.fulfillmentRepository.save(fulfillment);

    await this.emitCreated(saved, correlationId);

    this.logger.info(
      { correlationId, orderId, fulfillmentId: saved.id, status: saved.status },
      'Fulfillment created',
    );
    return toFulfillmentView(saved);
  }

  private static assertFulfillable(order: Order): void {
    if (order.status !== OrderStatusEnum.PENDING && order.status !== OrderStatusEnum.CONFIRMED) {
      throw new OrderDomainException(
        OrderErrorCodeEnum.ORDER_NOT_FULFILLABLE,
        `Order ${order.id} is ${order.status} and cannot be fulfilled`,
      );
    }
    if (
      order.paymentStatus !== OrderPaymentStatusEnum.AUTHORIZED &&
      order.paymentStatus !== OrderPaymentStatusEnum.CAPTURED
    ) {
      throw new OrderDomainException(
        OrderErrorCodeEnum.ORDER_NOT_FULFILLABLE,
        `Order ${order.id} payment is ${order.paymentStatus}; an authorized or captured payment is required to fulfill`,
      );
    }
  }

  private async assertWithinRemaining(
    order: Order,
    lines: { orderLineId: number; quantity: number }[],
  ): Promise<void> {
    const orderId = order.id!;
    const activeByLine = new Map<number, number>();
    for (const line of order.lines) {
      activeByLine.set(line.id!, line.activeQuantity);
    }

    const existing = await this.fulfillmentRepository.listByOrderId(orderId);
    const alreadyByLine = sumLineQuantitiesByOrderLine(existing, countsTowardFulfilled);

    const requestedByLine = new Map<number, number>();
    for (const requested of lines) {
      if (!activeByLine.has(requested.orderLineId)) {
        throw new OrderDomainException(
          OrderErrorCodeEnum.ORDER_LINE_NOT_FOUND,
          `Order line ${requested.orderLineId} does not belong to order ${orderId}`,
        );
      }
      requestedByLine.set(
        requested.orderLineId,
        (requestedByLine.get(requested.orderLineId) ?? 0) + requested.quantity,
      );
    }

    for (const [orderLineId, requested] of requestedByLine) {
      const active = activeByLine.get(orderLineId)!;
      const already = alreadyByLine.get(orderLineId) ?? 0;
      const remaining = active - already;
      if (requested > remaining) {
        throw new OrderDomainException(
          OrderErrorCodeEnum.FULFILLMENT_QUANTITY_EXCEEDS_REMAINING,
          `Order line ${orderLineId}: requested ${requested} exceeds the remaining ${remaining} (active ${active}, already fulfilled ${already})`,
        );
      }
    }
  }

  private async emitCreated(fulfillment: Fulfillment, correlationId: string): Promise<void> {
    try {
      await this.publisher.publishFulfillmentCreated({
        orderId: fulfillment.orderId,
        fulfillmentId: fulfillment.id!,
        stockLocationId: fulfillment.stockLocationId,
        lineQuantities: fulfillment.lines.map((line) => ({
          orderLineId: line.orderLineId,
          quantity: line.quantity,
        })),
        eventVersion: 'v1',
        occurredAt: new Date().toISOString(),
        correlationId,
      });
    } catch (error) {
      this.logger.warn(
        { err: error as Error, correlationId, fulfillmentId: fulfillment.id },
        'Failed to publish retail.fulfillment.created (fulfillment already committed)',
      );
    }
  }
}
