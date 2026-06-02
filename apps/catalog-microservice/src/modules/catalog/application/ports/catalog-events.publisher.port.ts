import { ICatalogVariantCreatedEvent } from '@retail-inventory-system/contracts';

export const CATALOG_EVENTS_PUBLISHER = Symbol('CATALOG_EVENTS_PUBLISHER');

// The outbound-event seam for the catalog write path. The use case builds the
// versioned wire event (after persistence assigns the concrete `variantId`) and
// hands it here; the adapter materializes the cold `ClientProxy.emit()`
// Observable with `firstValueFrom` so callers depend on a plain Promise. Keeping
// the wire event construction in the use case (not the adapter) follows ADR-025
// — the in-process `DomainEvent` is drained and mapped at the application layer.
//
// Publish-product-published / publish-product-archived methods join this port
// when the publish/archive use cases land.
export interface ICatalogEventsPublisherPort {
  publishVariantCreated(event: ICatalogVariantCreatedEvent, correlationId?: string): Promise<void>;
}
