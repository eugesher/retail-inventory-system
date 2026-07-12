import {
  ICatalogPriceChangedEvent,
  ICatalogPriceScheduledEvent,
} from '@retail-inventory-system/contracts';

export const PRICING_EVENTS_PUBLISHER = Symbol('PRICING_EVENTS_PUBLISHER');

// The outbound-event seam for the pricing write path. `SetPriceUseCase` builds
// the versioned `v1` wire event from the persisted row and hands it here; the
// adapter materializes the cold `ClientProxy.emit()` Observable with
// `firstValueFrom` so callers depend on a plain Promise. Mirrors
// `ICatalogEventsPublisherPort` — the `Price` is not an `AggregateRoot` and
// records no `DomainEvent`, so the use case constructs the wire event directly
// from the saved `Price` rather than draining one.
//
// One method per pricing write event: an immediate price change
// (`catalog.price.changed`) and a scheduled future price (`catalog.price.scheduled`).
//
// Both ride `catalog_queue`, where **no `@EventPattern` binds them** — a reserved surface. But
// "reserved" is not "unread": the adapter also mirrors each one onto the `ris.events` topic
// exchange (ADR-035), and the event store's firehose consumes that exchange wholesale. **A price
// event is durably captured today**, in `ris_eventstore`. It simply has no *business* consumer.
export interface IPricingEventsPublisherPort {
  publishPriceChanged(event: ICatalogPriceChangedEvent, correlationId?: string): Promise<void>;
  publishPriceScheduled(event: ICatalogPriceScheduledEvent, correlationId?: string): Promise<void>;
}
