import {
  IRetailReturnAuthorizedEvent,
  IRetailReturnClosedEvent,
  IRetailReturnInspectedEvent,
  IRetailReturnReceivedEvent,
  IRetailReturnRejectedEvent,
  IRetailReturnRequestedEvent,
} from '@retail-inventory-system/contracts';

export const RETURN_EVENTS_PUBLISHER = Symbol('RETURN_EVENTS_PUBLISHER');

// The returns context's event-publishing seam. The use case has already built the
// versioned wire event; the adapter just emits it and waits for the broker ack.
// Domain/contract types only — no `@nestjs/microservices` here (ADR-009); the concrete
// `ReturnRabbitmqPublisher` holds the two `ClientProxy`s.
//
// Two destinations, by the producer-targets-consumer-queue pattern (ADR-008/020):
// `publishReturnRequested` / `publishReturnAuthorized` / `publishReturnReceived` /
// `publishReturnInspected` emit `retail.return.requested` / `.authorized` / `.received` /
// `.inspected` onto `notification_events` (the notification service's own queue — it
// consumes the buyer-facing ones for its returns fan-out); `publishReturnRejected` /
// `publishReturnClosed` emit `retail.return.rejected` / `.closed` onto `retail_queue` (the
// producer's own queue — reserved surfaces today, no consumer). Each is a best-effort
// post-commit emit — the write has already committed, so a publish failure is warn-logged
// and swallowed by the caller (ADR-020).
export interface IReturnEventsPublisherPort {
  publishReturnRequested(event: IRetailReturnRequestedEvent): Promise<void>;
  publishReturnAuthorized(event: IRetailReturnAuthorizedEvent): Promise<void>;
  publishReturnRejected(event: IRetailReturnRejectedEvent): Promise<void>;
  publishReturnReceived(event: IRetailReturnReceivedEvent): Promise<void>;
  publishReturnInspected(event: IRetailReturnInspectedEvent): Promise<void>;
  publishReturnClosed(event: IRetailReturnClosedEvent): Promise<void>;
}
