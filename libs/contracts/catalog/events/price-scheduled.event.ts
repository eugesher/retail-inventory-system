import { ICatalogPriceChangedEvent } from './price-changed.event';

// Wire-format shape for `catalog.price.scheduled`, published by the pricing
// module after a **future** price is appended (its `validFrom` is strictly after
// now, so the new amount does not take effect until then — the current price
// stays the answer until the changeover). It is the `catalog.price.changed`
// payload plus one field, `effectiveAt`: the instant the scheduled price becomes
// applicable, equal to its `validFrom`.
//
// The two events are deliberately distinct routing keys (not one event with a
// flag) so a consumer can subscribe to "a price changed *right now*" without
// also waking for "a price is *scheduled* to change later". Same `'v1'` version
// pinning and ISO-8601 timestamp convention as the parent event.
export interface ICatalogPriceScheduledEvent extends ICatalogPriceChangedEvent {
  effectiveAt: string;
}
