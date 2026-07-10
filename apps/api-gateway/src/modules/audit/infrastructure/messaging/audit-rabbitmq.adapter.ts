import { Inject, Injectable } from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import { firstValueFrom } from 'rxjs';

import {
  AuditLogEntryView,
  DomainEventView,
  IAuditLogQueryPayload,
  ICorrelationTracePayload,
  ICorrelationTraceResult,
  IDomainEventQueryPayload,
  IPage,
} from '@retail-inventory-system/contracts';
import { MicroserviceClientTokenEnum, ROUTING_KEYS } from '@retail-inventory-system/messaging';

import { IAuditGatewayPort } from '../../application/ports';

// The single `ClientProxy` holder for the audit gateway module (ADR-009 / ADR-020).
// Each method materializes the RPC with `firstValueFrom`; everything else in the module
// depends on `IAuditGatewayPort`, never on `@nestjs/microservices`.
//
// The three `audit.*` query RPCs land on `event_store_query_queue` — the event store's
// SECOND transport, on the DEFAULT exchange — through the `EVENT_STORE_MICROSERVICE`
// client (ADR-039). That is a request/reply channel, and it is not the
// `RIS_EVENTS_PUBLISHER` client: the same deployable is reachable both ways, but events
// ride the `ris.events` topic exchange and commands ride this one.
//
// The payloads arrive fully assembled (the use case already folded the request's
// REQUIRED `correlationId` onto them), so — like `InventoryRabbitmqAdapter`'s audit-list
// and sweep methods — there is no separate `correlationId` argument to stitch here.
//
// A downstream rejection propagates as-is; `throwRpcError` in each use case turns its
// `{ statusCode, message, code }` into the matching HTTP error. The event store raises
// none today: an unknown filter, an unknown correlation id and an inverted `from`/`to`
// window all answer with an empty result (ADR-039). The realistic failure is a transport
// one — no consumer on `event_store_query_queue` means the reply never arrives.
@Injectable()
export class AuditRabbitmqAdapter implements IAuditGatewayPort {
  constructor(
    @Inject(MicroserviceClientTokenEnum.EVENT_STORE_MICROSERVICE)
    private readonly client: ClientProxy,
  ) {}

  public async queryEvents(payload: IDomainEventQueryPayload): Promise<IPage<DomainEventView>> {
    return firstValueFrom(
      this.client.send<IPage<DomainEventView>, IDomainEventQueryPayload>(
        ROUTING_KEYS.AUDIT_EVENT_QUERY,
        payload,
      ),
    );
  }

  public async queryEntries(payload: IAuditLogQueryPayload): Promise<IPage<AuditLogEntryView>> {
    return firstValueFrom(
      this.client.send<IPage<AuditLogEntryView>, IAuditLogQueryPayload>(
        ROUTING_KEYS.AUDIT_ENTRY_QUERY,
        payload,
      ),
    );
  }

  public async traceByCorrelation(
    payload: ICorrelationTracePayload,
  ): Promise<ICorrelationTraceResult> {
    return firstValueFrom(
      this.client.send<ICorrelationTraceResult, ICorrelationTracePayload>(
        ROUTING_KEYS.AUDIT_TRACE_BY_CORRELATION,
        payload,
      ),
    );
  }
}
