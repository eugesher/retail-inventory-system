import { Inject, Injectable } from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import { firstValueFrom } from 'rxjs';

import {
  IRetailOrderCancelledEvent,
  IRetailOrderConfirmedEvent,
  IRetailOrderCreatedEvent,
  OrderStatusEnum,
} from '@retail-inventory-system/contracts';
import { MicroserviceClientTokenEnum, ROUTING_KEYS } from '@retail-inventory-system/messaging';

import { OrderCancelledEvent, OrderConfirmedEvent, OrderCreatedEvent } from '../../domain';
import { IOrderEventsPublisherPort } from '../../application/ports';

@Injectable()
export class OrderRabbitmqPublisher implements IOrderEventsPublisherPort {
  constructor(
    @Inject(MicroserviceClientTokenEnum.NOTIFICATION_MICROSERVICE)
    private readonly notificationClient: ClientProxy,
  ) {}

  public async publishOrderCreated(
    event: OrderCreatedEvent,
    correlationId?: string,
  ): Promise<void> {
    const wire: IRetailOrderCreatedEvent = {
      orderId: event.aggregateId,
      customerId: event.customerId,
      status: OrderStatusEnum.PENDING,
      products: event.lines.map((line) => ({
        productId: line.productId,
        quantity: line.quantity,
      })),
      occurredAt: event.occurredAt.toISOString(),
      // The wire contract makes `correlationId` required. The use case
      // threads the real id from the inbound RPC payload; the empty-string
      // default is a defensive fallback (see _carryover-08 §9 #4).
      correlationId: correlationId ?? '',
    };

    // `ClientProxy.emit()` returns a cold Observable; `firstValueFrom`
    // materializes it and waits for the broker ack so application code can
    // await a plain Promise (see _carryover-07 §5 #3).
    await firstValueFrom(
      this.notificationClient.emit<void, IRetailOrderCreatedEvent>(
        ROUTING_KEYS.RETAIL_ORDER_CREATED,
        wire,
      ),
    );
  }

  public async publishOrderConfirmed(
    event: OrderConfirmedEvent,
    correlationId?: string,
  ): Promise<void> {
    const wire: IRetailOrderConfirmedEvent = {
      orderId: event.aggregateId,
      customerId: event.customerId,
      status: OrderStatusEnum.CONFIRMED,
      products: event.lines.map((line) => ({
        orderProductId: line.orderProductId,
        productId: line.productId,
      })),
      occurredAt: event.occurredAt.toISOString(),
      correlationId: correlationId ?? '',
    };

    await firstValueFrom(
      this.notificationClient.emit<void, IRetailOrderConfirmedEvent>(
        ROUTING_KEYS.RETAIL_ORDER_CONFIRMED,
        wire,
      ),
    );
  }

  public async publishOrderCancelled(
    event: OrderCancelledEvent,
    correlationId?: string,
  ): Promise<void> {
    const wire: IRetailOrderCancelledEvent = {
      orderId: event.aggregateId,
      customerId: event.customerId,
      reason: event.reason,
      occurredAt: event.occurredAt.toISOString(),
      correlationId: correlationId ?? '',
    };

    await firstValueFrom(
      this.notificationClient.emit<void, IRetailOrderCancelledEvent>(
        ROUTING_KEYS.RETAIL_ORDER_CANCELLED,
        wire,
      ),
    );
  }
}
