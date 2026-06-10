import {
  IRetailCartCreatedEvent,
  IRetailCartLineAddedEvent,
  IRetailCartLineQuantityChangedEvent,
  IRetailCartLineRemovedEvent,
} from '@retail-inventory-system/contracts';

export const CART_EVENTS_PUBLISHER = Symbol('CART_EVENTS_PUBLISHER');

// The outbound-event seam for the cart write path. Each cart operation builds the
// versioned wire event (after draining the in-process `DomainEvent`) and hands it
// here; `CartRabbitmqPublisher` materializes the cold `ClientProxy.emit()`
// Observable with `firstValueFrom`. Keeping the wire-event construction in the
// use case (not the adapter) follows the catalog pattern (ADR-025): the
// in-process `DomainEvent` is drained and mapped at the application layer — a
// `DomainEvent` subclass is never serialized across services (ADR-011).
//
// All four are reserved surfaces today — emitted onto the retail service's own
// `retail_queue` with no cross-service consumer bound yet (the
// producer-targets-consumer-queue pattern, ADR-008 / ADR-020). A publish failure
// is best-effort: the use case warn-logs and swallows it because the cart write
// has already committed.
export interface ICartEventsPublisherPort {
  publishCartCreated(event: IRetailCartCreatedEvent, correlationId?: string): Promise<void>;
  publishCartLineAdded(event: IRetailCartLineAddedEvent, correlationId?: string): Promise<void>;
  publishCartLineRemoved(event: IRetailCartLineRemovedEvent, correlationId?: string): Promise<void>;
  publishCartLineQuantityChanged(
    event: IRetailCartLineQuantityChangedEvent,
    correlationId?: string,
  ): Promise<void>;
}
