import { ICatalogPriceChangedEvent } from './price-changed.event';

export interface ICatalogPriceScheduledEvent extends ICatalogPriceChangedEvent {
  effectiveAt: string;
}
