import {
  ICatalogProductArchivedEvent,
  ICatalogProductPublishedEvent,
  ICatalogVariantCreatedEvent,
} from '@retail-inventory-system/contracts';

export const CATALOG_EVENTS_PUBLISHER = Symbol('CATALOG_EVENTS_PUBLISHER');

// The outbound-event seam for the catalog write path. The use case builds the
// versioned wire event (after persistence drains the in-process `DomainEvent`)
// and hands it here; the adapter materializes the cold `ClientProxy.emit()`
// Observable with `firstValueFrom` so callers depend on a plain Promise. Keeping
// the wire event construction in the use case (not the adapter) follows ADR-025
// — the in-process `DomainEvent` is drained and mapped at the application layer.
//
// One method per catalog write event: a variant appended to a product
// (`catalog.variant.created`), a product published (`catalog.product.published`),
// and a product archived (`catalog.product.archived`).
export interface ICatalogEventsPublisherPort {
  publishVariantCreated(event: ICatalogVariantCreatedEvent, correlationId?: string): Promise<void>;
  publishProductPublished(
    event: ICatalogProductPublishedEvent,
    correlationId?: string,
  ): Promise<void>;
  publishProductArchived(
    event: ICatalogProductArchivedEvent,
    correlationId?: string,
  ): Promise<void>;
}
