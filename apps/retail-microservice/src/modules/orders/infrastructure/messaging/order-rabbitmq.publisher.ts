import { Inject, Injectable } from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import { firstValueFrom } from 'rxjs';

import {
  IRetailFulfillmentCreatedEvent,
  IRetailFulfillmentDeliveredEvent,
  IRetailFulfillmentShippedEvent,
  IRetailOrderCancelledEvent,
  IRetailOrderPlacedEvent,
  IRetailPaymentAuthorizedEvent,
  IRetailPaymentCapturedEvent,
  IRetailRefundFailedEvent,
  IRetailRefundIssuedEvent,
} from '@retail-inventory-system/contracts';
import {
  MicroserviceClientTokenEnum,
  RisEventsMirrorPublisher,
  ROUTING_KEYS,
} from '@retail-inventory-system/messaging';

import { IOrderEventsPublisherPort } from '../../application/ports';

@Injectable()
export class OrderRabbitmqPublisher implements IOrderEventsPublisherPort {
  constructor(
    @Inject(MicroserviceClientTokenEnum.NOTIFICATION_MICROSERVICE)
    private readonly notificationClient: ClientProxy,
    @Inject(MicroserviceClientTokenEnum.RETAIL_MICROSERVICE)
    private readonly retailClient: ClientProxy,
    private readonly risEvents: RisEventsMirrorPublisher,
  ) {}

  public async publishOrderPlaced(event: IRetailOrderPlacedEvent): Promise<void> {
    await firstValueFrom(
      this.notificationClient.emit<void, IRetailOrderPlacedEvent>(
        ROUTING_KEYS.RETAIL_ORDER_PLACED,
        event,
      ),
    );
    await this.risEvents.mirror(ROUTING_KEYS.RETAIL_ORDER_PLACED, event);
  }

  public async publishPaymentAuthorized(event: IRetailPaymentAuthorizedEvent): Promise<void> {
    await firstValueFrom(
      this.retailClient.emit<void, IRetailPaymentAuthorizedEvent>(
        ROUTING_KEYS.RETAIL_PAYMENT_AUTHORIZED,
        event,
      ),
    );
    await this.risEvents.mirror(ROUTING_KEYS.RETAIL_PAYMENT_AUTHORIZED, event);
  }

  public async publishPaymentCaptured(event: IRetailPaymentCapturedEvent): Promise<void> {
    await firstValueFrom(
      this.retailClient.emit<void, IRetailPaymentCapturedEvent>(
        ROUTING_KEYS.RETAIL_PAYMENT_CAPTURED,
        event,
      ),
    );
    await this.risEvents.mirror(ROUTING_KEYS.RETAIL_PAYMENT_CAPTURED, event);
  }

  public async publishFulfillmentCreated(event: IRetailFulfillmentCreatedEvent): Promise<void> {
    await firstValueFrom(
      this.retailClient.emit<void, IRetailFulfillmentCreatedEvent>(
        ROUTING_KEYS.RETAIL_FULFILLMENT_CREATED,
        event,
      ),
    );
    await this.risEvents.mirror(ROUTING_KEYS.RETAIL_FULFILLMENT_CREATED, event);
  }

  public async publishFulfillmentShipped(event: IRetailFulfillmentShippedEvent): Promise<void> {
    await firstValueFrom(
      this.notificationClient.emit<void, IRetailFulfillmentShippedEvent>(
        ROUTING_KEYS.RETAIL_FULFILLMENT_SHIPPED,
        event,
      ),
    );
    await this.risEvents.mirror(ROUTING_KEYS.RETAIL_FULFILLMENT_SHIPPED, event);
  }

  public async publishFulfillmentDelivered(event: IRetailFulfillmentDeliveredEvent): Promise<void> {
    await firstValueFrom(
      this.notificationClient.emit<void, IRetailFulfillmentDeliveredEvent>(
        ROUTING_KEYS.RETAIL_FULFILLMENT_DELIVERED,
        event,
      ),
    );
    await this.risEvents.mirror(ROUTING_KEYS.RETAIL_FULFILLMENT_DELIVERED, event);
  }

  public async publishOrderCancelled(event: IRetailOrderCancelledEvent): Promise<void> {
    await Promise.all([
      firstValueFrom(
        this.retailClient.emit<void, IRetailOrderCancelledEvent>(
          ROUTING_KEYS.RETAIL_ORDER_CANCELLED,
          event,
        ),
      ),
      firstValueFrom(
        this.notificationClient.emit<void, IRetailOrderCancelledEvent>(
          ROUTING_KEYS.RETAIL_ORDER_CANCELLED,
          event,
        ),
      ),
    ]);
    await this.risEvents.mirror(ROUTING_KEYS.RETAIL_ORDER_CANCELLED, event);
  }

  public async publishRefundIssued(event: IRetailRefundIssuedEvent): Promise<void> {
    await firstValueFrom(
      this.notificationClient.emit<void, IRetailRefundIssuedEvent>(
        ROUTING_KEYS.RETAIL_REFUND_ISSUED,
        event,
      ),
    );
    await this.risEvents.mirror(ROUTING_KEYS.RETAIL_REFUND_ISSUED, event);
  }

  public async publishRefundFailed(event: IRetailRefundFailedEvent): Promise<void> {
    await firstValueFrom(
      this.retailClient.emit<void, IRetailRefundFailedEvent>(
        ROUTING_KEYS.RETAIL_REFUND_FAILED,
        event,
      ),
    );
    await this.risEvents.mirror(ROUTING_KEYS.RETAIL_REFUND_FAILED, event);
  }
}
