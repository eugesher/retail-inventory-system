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

export const ORDER_EVENTS_PUBLISHER = Symbol('ORDER_EVENTS_PUBLISHER');

export interface IOrderEventsPublisherPort {
  publishOrderPlaced(event: IRetailOrderPlacedEvent): Promise<void>;
  publishPaymentAuthorized(event: IRetailPaymentAuthorizedEvent): Promise<void>;
  publishPaymentCaptured(event: IRetailPaymentCapturedEvent): Promise<void>;
  publishFulfillmentCreated(event: IRetailFulfillmentCreatedEvent): Promise<void>;
  publishFulfillmentShipped(event: IRetailFulfillmentShippedEvent): Promise<void>;
  publishFulfillmentDelivered(event: IRetailFulfillmentDeliveredEvent): Promise<void>;
  publishOrderCancelled(event: IRetailOrderCancelledEvent): Promise<void>;
  publishRefundIssued(event: IRetailRefundIssuedEvent): Promise<void>;
  publishRefundFailed(event: IRetailRefundFailedEvent): Promise<void>;
}
