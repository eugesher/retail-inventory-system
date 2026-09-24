import {
  ICatalogPriceChangedEvent,
  ICatalogPriceScheduledEvent,
} from '@retail-inventory-system/contracts';

export const PRICING_EVENTS_PUBLISHER = Symbol('PRICING_EVENTS_PUBLISHER');

export interface IPricingEventsPublisherPort {
  publishPriceChanged(event: ICatalogPriceChangedEvent, correlationId?: string): Promise<void>;
  publishPriceScheduled(event: ICatalogPriceScheduledEvent, correlationId?: string): Promise<void>;
}
