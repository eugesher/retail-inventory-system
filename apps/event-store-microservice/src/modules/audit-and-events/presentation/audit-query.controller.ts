import { Controller } from '@nestjs/common';
import { MessagePattern, Payload } from '@nestjs/microservices';

import {
  AuditLogEntryView,
  DomainEventView,
  IAuditLogQueryPayload,
  ICorrelationTracePayload,
  ICorrelationTraceResult,
  IDomainEventQueryPayload,
  IPage,
} from '@retail-inventory-system/contracts';
import { ROUTING_KEYS } from '@retail-inventory-system/messaging';

import {
  QueryAuditLogEntriesUseCase,
  QueryDomainEventsUseCase,
  TraceByCorrelationUseCase,
} from '../application/use-cases';

// The event store's `@MessagePattern` surface — the three `audit.*` query RPCs of ADR-039.
// They arrive on `event_store_query_queue`, a SECOND transport this one Nest application
// connects, bound to the DEFAULT exchange and disjoint from the `ris.events`-bound
// `event_store_firehose_queue` the `FirehoseConsumer` serves. Commands ride the default
// exchange; events ride the topic exchange. The service still opens no HTTP port.
//
// Two consequences of "one app binds every handler to every connected transport" are
// visible here, and both are inert:
//   - the firehose transport (`wildcards: true`) additionally binds these three routing
//     keys onto `ris.events`, because `ServerRMQ.listen()` binds every registered handler
//     pattern as a routing key. Nothing publishes them there;
//   - the query transport additionally registers `FirehoseConsumer`'s `@EventPattern('#')`
//     as the literal map key `'#'`. With `wildcards: false`, `ServerRMQ.getHandlerByPattern`
//     is an exact map lookup, so `#` matches nothing and `audit.event.query` resolves here.
//
// All three use cases are this module's own (ADR-042), so this is an ordinary `presentation/`
// controller. Under the earlier two-module split the trio spanned both modules, so it could
// live in neither module's `presentation/` and sat at a bespoke context root instead.
//
// Three thin delegations (ADR-011 §4). `correlationId` is logged inline inside each use
// case — never via `PinoLogger.assign()`, which throws outside a request scope (ADR-011 §7)
// — so the controller carries no logging of its own, exactly like every other RPC controller
// in this repository.
//
// There is NO `*RpcExceptionFilter` here, and no domain exception to map. The event store
// answers an unknown filter, an unknown correlation id, and an inverted `from`/`to` window
// with an empty result rather than a rejection; shape errors belong to the gateway DTO
// (ADR-039).
@Controller()
export class AuditQueryController {
  constructor(
    private readonly queryDomainEvents: QueryDomainEventsUseCase,
    private readonly queryAuditLogEntries: QueryAuditLogEntriesUseCase,
    private readonly traceByCorrelation: TraceByCorrelationUseCase,
  ) {}

  @MessagePattern(ROUTING_KEYS.AUDIT_EVENT_QUERY)
  public async handleQueryDomainEvents(
    @Payload() payload: IDomainEventQueryPayload,
  ): Promise<IPage<DomainEventView>> {
    return this.queryDomainEvents.execute(payload);
  }

  @MessagePattern(ROUTING_KEYS.AUDIT_ENTRY_QUERY)
  public async handleQueryAuditLogEntries(
    @Payload() payload: IAuditLogQueryPayload,
  ): Promise<IPage<AuditLogEntryView>> {
    return this.queryAuditLogEntries.execute(payload);
  }

  @MessagePattern(ROUTING_KEYS.AUDIT_TRACE_BY_CORRELATION)
  public async handleTraceByCorrelation(
    @Payload() payload: ICorrelationTracePayload,
  ): Promise<ICorrelationTraceResult> {
    return this.traceByCorrelation.execute(payload);
  }
}
