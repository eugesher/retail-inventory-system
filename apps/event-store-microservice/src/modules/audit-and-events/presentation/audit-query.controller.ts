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
