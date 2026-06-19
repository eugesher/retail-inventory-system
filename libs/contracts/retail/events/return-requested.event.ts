import { ICorrelationPayload } from '../../microservices';

// Wire-format shape for the `retail.return.requested` event, published by the retail
// microservice after a return request is opened (the `ReturnRequest` is persisted and
// its `RMA-<year>-<pad8(id)>` number finalized). Framework-free — a domain object is
// never serialized across services (ADR-011); the Open use case maps the saved aggregate
// onto this interface before emitting.
//
// It is the past-tense counterpart of the imperative `retail.return.open` command (the
// `catalog.variant.create`/`.created` split, ADR-008). Emitted onto `notification_events`
// (the consumer's own queue — the producer-targets-consumer-queue pattern
// `retail.order.placed` uses, ADR-008/020), where the notification service binds a
// return-acknowledgement consumer for it, so it is a best-effort post-commit emit
// (ADR-020). `rmaId` / `rmaNumber` identify the RMA, `orderId` / `customerId` the order
// the goods came from and the buyer, `lineCount` how many lines are coming back.
// `eventVersion` is pinned to `'v1'`; a breaking change ships `'v2'`. `occurredAt` and
// `requestedAt` are ISO-8601 strings.
export interface IRetailReturnRequestedEvent extends ICorrelationPayload {
  rmaId: number;
  rmaNumber: string;
  orderId: number;
  customerId: string;
  requestedAt: string;
  lineCount: number;
  eventVersion: 'v1';
  occurredAt: string;
}
