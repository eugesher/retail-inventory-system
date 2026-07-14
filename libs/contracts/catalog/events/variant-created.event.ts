import { ICorrelationPayload } from '../../microservices';

// `catalog.variant.created` — **the one catalog event with a real consumer.** Inventory's
// `CatalogEventsConsumer` binds it and auto-initialises a zeroed `stock_level` row for the new
// variant.
//
// It is therefore emitted onto **`inventory_queue`**, not `catalog_queue`: an event goes to the
// queue of whoever consumes it (ADR-008/020). The catalog service's own client carries only the
// two reserved-surface `product.*` events.
export interface ICatalogVariantCreatedEvent extends ICorrelationPayload {
  productId: number;
  variantId: number;
  sku: string;
  eventVersion: 'v1';
  occurredAt: string;
}
