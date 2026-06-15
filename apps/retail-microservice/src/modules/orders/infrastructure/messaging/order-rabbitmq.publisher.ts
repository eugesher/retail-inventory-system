import { Inject, Injectable } from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import { firstValueFrom } from 'rxjs';

import {
  IRetailFulfillmentCreatedEvent,
  IRetailFulfillmentShippedEvent,
  IRetailOrderPlacedEvent,
  IRetailPaymentAuthorizedEvent,
  IRetailPaymentCapturedEvent,
} from '@retail-inventory-system/contracts';
import { MicroserviceClientTokenEnum, ROUTING_KEYS } from '@retail-inventory-system/messaging';

import { IOrderEventsPublisherPort } from '../../application/ports';

// The orders context's event publisher and the second of the module's `ClientProxy`
// holders (ADR-009 / ADR-020). The use case has already built the versioned wire
// event; this adapter just emits it and waits for the broker ack.
//
// `retail.order.placed` is emitted through the `NOTIFICATION_MICROSERVICE` client so
// it lands on `notification_events` — the consumer's own queue, the
// producer-targets-consumer-queue pattern (ADR-008/020) that `inventory.stock.low →
// notification_events` uses. Its consumer (an order-confirmation fan-out) binds with
// the notification re-point capability. `retail.payment.authorized` is emitted
// through the `RETAIL_MICROSERVICE` client onto `retail_queue` (the producer's own
// queue) — a reserved surface today, like the four `retail.cart.*` events.
@Injectable()
export class OrderRabbitmqPublisher implements IOrderEventsPublisherPort {
  constructor(
    @Inject(MicroserviceClientTokenEnum.NOTIFICATION_MICROSERVICE)
    private readonly notificationClient: ClientProxy,
    @Inject(MicroserviceClientTokenEnum.RETAIL_MICROSERVICE)
    private readonly retailClient: ClientProxy,
  ) {}

  public async publishOrderPlaced(event: IRetailOrderPlacedEvent): Promise<void> {
    // `ClientProxy.emit()` is a cold Observable; `firstValueFrom` materializes it
    // and waits for the broker ack so callers depend on a plain Promise.
    await firstValueFrom(
      this.notificationClient.emit<void, IRetailOrderPlacedEvent>(
        ROUTING_KEYS.RETAIL_ORDER_PLACED,
        event,
      ),
    );
  }

  public async publishPaymentAuthorized(event: IRetailPaymentAuthorizedEvent): Promise<void> {
    await firstValueFrom(
      this.retailClient.emit<void, IRetailPaymentAuthorizedEvent>(
        ROUTING_KEYS.RETAIL_PAYMENT_AUTHORIZED,
        event,
      ),
    );
  }

  public async publishPaymentCaptured(event: IRetailPaymentCapturedEvent): Promise<void> {
    await firstValueFrom(
      this.retailClient.emit<void, IRetailPaymentCapturedEvent>(
        ROUTING_KEYS.RETAIL_PAYMENT_CAPTURED,
        event,
      ),
    );
  }

  // `retail.fulfillment.created` rides the `RETAIL_MICROSERVICE` client onto
  // `retail_queue` (the producer's own queue) — a reserved surface today, like the
  // `retail.payment.*` events.
  public async publishFulfillmentCreated(event: IRetailFulfillmentCreatedEvent): Promise<void> {
    await firstValueFrom(
      this.retailClient.emit<void, IRetailFulfillmentCreatedEvent>(
        ROUTING_KEYS.RETAIL_FULFILLMENT_CREATED,
        event,
      ),
    );
  }

  // `retail.fulfillment.shipped` rides the `RETAIL_MICROSERVICE` client onto
  // `retail_queue` (the producer's own queue), where the notification service binds a
  // shipment-confirmation consumer.
  public async publishFulfillmentShipped(event: IRetailFulfillmentShippedEvent): Promise<void> {
    await firstValueFrom(
      this.retailClient.emit<void, IRetailFulfillmentShippedEvent>(
        ROUTING_KEYS.RETAIL_FULFILLMENT_SHIPPED,
        event,
      ),
    );
  }
}
