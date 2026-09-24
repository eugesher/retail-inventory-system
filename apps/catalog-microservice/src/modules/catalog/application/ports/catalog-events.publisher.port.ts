import {
  ICatalogProductArchivedEvent,
  ICatalogProductPublishedEvent,
  ICatalogVariantCreatedEvent,
} from '@retail-inventory-system/contracts';

export const CATALOG_EVENTS_PUBLISHER = Symbol('CATALOG_EVENTS_PUBLISHER');

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
