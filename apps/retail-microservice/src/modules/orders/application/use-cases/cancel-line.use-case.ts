import { Inject, Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';

import {
  IAllocationCancelPayload,
  INVENTORY_DEFAULT_STOCK_LOCATION,
  IRetailOrderCancelLinePayload,
  OrderView,
} from '@retail-inventory-system/contracts';

import { Order, OrderDomainException, OrderErrorCodeEnum } from '../../domain';
import {
  FULFILLMENT_REPOSITORY,
  IFulfillmentRepositoryPort,
  IOrderInventoryGatewayPort,
  IOrderRepositoryPort,
  IPaymentRepositoryPort,
  ITransactionPort,
  OCC_RETRY_ATTEMPTS,
  ORDER_INVENTORY_GATEWAY,
  ORDER_REPOSITORY,
  PAYMENT_REPOSITORY,
  TRANSACTION_PORT,
} from '../ports';
import { releaseAllocationWithRetry } from './cancel-allocation-retry';
import { countsTowardFulfilled, sumLineQuantitiesByOrderLine } from './fulfillment-quantities';
import { toOrderView } from './order-view.factory';
import { runWithOrderWriteRetry } from './order-write';

@Injectable()
export class CancelLineUseCase {
  constructor(
    @Inject(TRANSACTION_PORT)
    private readonly transactionPort: ITransactionPort,
    @Inject(ORDER_REPOSITORY)
    private readonly orderRepository: IOrderRepositoryPort,
    @Inject(FULFILLMENT_REPOSITORY)
    private readonly fulfillmentRepository: IFulfillmentRepositoryPort,
    @Inject(PAYMENT_REPOSITORY)
    private readonly paymentRepository: IPaymentRepositoryPort,
    @Inject(ORDER_INVENTORY_GATEWAY)
    private readonly inventoryGateway: IOrderInventoryGatewayPort,
    @Inject(OCC_RETRY_ATTEMPTS)
    private readonly maxAttempts: number,
    @InjectPinoLogger(CancelLineUseCase.name)
    private readonly logger: PinoLogger,
  ) {}

  public async execute(payload: IRetailOrderCancelLinePayload): Promise<OrderView> {
    const { orderId, orderLineId, quantity, actorId, isStaffCancel, correlationId } = payload;

    this.logger.info(
      { correlationId, orderId, orderLineId, quantity, actorId, isStaffCancel },
      'Cancelling order line',
    );

    const order = await this.orderRepository.findById(orderId);
    if (!order) {
      throw new OrderDomainException(
        OrderErrorCodeEnum.ORDER_NOT_FOUND,
        `Order ${orderId} not found`,
      );
    }
    if (!isStaffCancel) {
      throw new OrderDomainException(
        OrderErrorCodeEnum.ORDER_ACCESS_FORBIDDEN,
        `Order ${orderId} line cancel requires staff (order:cancel)`,
      );
    }

    const { saved, cancelledQuantity, variantId } = await runWithOrderWriteRetry(
      { logger: this.logger, maxAttempts: this.maxAttempts },
      () => this.cancelLineInTransaction(orderId, orderLineId, quantity),
      { orderId, correlationId },
    );

    await releaseAllocationWithRetry(
      this.inventoryGateway,
      CancelLineUseCase.buildCancelAllocationPayload(
        saved,
        variantId,
        cancelledQuantity,
        actorId,
        correlationId,
      ),
      this.logger,
      correlationId,
    );

    const payment = await this.paymentRepository.findByOrderId(orderId);

    this.logger.info(
      { correlationId, orderId, orderLineId, cancelledQuantity },
      'Order line cancelled',
    );
    return toOrderView(saved, payment);
  }

  private cancelLineInTransaction(
    orderId: number,
    orderLineId: number,
    quantity: number | undefined,
  ): Promise<{ saved: Order; cancelledQuantity: number; variantId: number }> {
    return this.transactionPort.runInTransaction(async (scope) => {
      const order = await this.orderRepository.findById(orderId, scope);
      if (!order) {
        throw new OrderDomainException(
          OrderErrorCodeEnum.ORDER_NOT_FOUND,
          `Order ${orderId} vanished while cancelling a line`,
        );
      }
      const line = order.lines.find((candidate) => candidate.id === orderLineId);
      if (!line) {
        throw new OrderDomainException(
          OrderErrorCodeEnum.ORDER_LINE_NOT_FOUND,
          `Order line ${orderLineId} does not belong to order ${orderId}`,
        );
      }

      const fulfillments = await this.fulfillmentRepository.listByOrderId(orderId, scope);
      const alreadyFulfilled =
        sumLineQuantitiesByOrderLine(fulfillments, countsTowardFulfilled).get(orderLineId) ?? 0;
      const cancellable = line.activeQuantity - alreadyFulfilled;
      const cancelQty = quantity ?? cancellable;
      if (cancelQty <= 0 || cancelQty > cancellable) {
        throw new OrderDomainException(
          OrderErrorCodeEnum.FULFILLMENT_QUANTITY_EXCEEDS_REMAINING,
          `Order line ${orderLineId}: cannot cancel ${cancelQty} of the ${cancellable} cancellable (ordered ${line.quantity}, already cancelled ${line.cancelledQuantity}, already fulfilled ${alreadyFulfilled})`,
        );
      }

      const versionAtLoad = order.version;
      order.cancelLineQuantity(orderLineId, cancelQty);
      const saved = await this.orderRepository.save(order, scope, versionAtLoad);

      return { saved, cancelledQuantity: cancelQty, variantId: line.variantId };
    });
  }

  private static buildCancelAllocationPayload(
    order: Order,
    variantId: number,
    quantity: number,
    actorId: string,
    correlationId: string,
  ): Omit<IAllocationCancelPayload, 'operationKey'> {
    return {
      orderId: order.id!,
      lines: [{ variantId, stockLocationId: INVENTORY_DEFAULT_STOCK_LOCATION, quantity }],
      reason: 'line-cancelled',
      actorId,
      correlationId,
    };
  }
}
