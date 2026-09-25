import { Inject, Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';

import {
  ICorrelationTracePayload,
  ICorrelationTraceResult,
} from '@retail-inventory-system/contracts';

import {
  AUDIT_LOG_REPOSITORY,
  DOMAIN_EVENT_REPOSITORY,
  IAuditLogRepositoryPort,
  IDomainEventRepositoryPort,
} from '../ports';
import { toAuditLogEntryView } from './audit-log-entry-view.factory';
import { toDomainEventView } from './domain-event-view.factory';

@Injectable()
export class TraceByCorrelationUseCase {
  constructor(
    @Inject(AUDIT_LOG_REPOSITORY)
    private readonly auditLogRepository: IAuditLogRepositoryPort,
    @Inject(DOMAIN_EVENT_REPOSITORY)
    private readonly domainEventRepository: IDomainEventRepositoryPort,
    @InjectPinoLogger(TraceByCorrelationUseCase.name)
    private readonly logger: PinoLogger,
  ) {}

  public async execute(payload: ICorrelationTracePayload): Promise<ICorrelationTraceResult> {
    const { targetCorrelationId, correlationId } = payload;

    this.logger.info(
      { correlationId, targetCorrelationId },
      'Received RPC: trace by correlation id (cross-log causal chain)',
    );

    if (typeof targetCorrelationId !== 'string' || targetCorrelationId.trim() === '') {
      this.logger.warn(
        { correlationId },
        'Trace by correlation id: blank target — returning an empty trace',
      );
      return { events: [], auditEntries: [] };
    }

    const [events, auditEntries] = await Promise.all([
      this.domainEventRepository.listByCorrelationId(targetCorrelationId),
      this.auditLogRepository.listByCorrelationId(targetCorrelationId),
    ]);

    return {
      events: events.map(toDomainEventView),
      auditEntries: auditEntries.map(toAuditLogEntryView),
    };
  }
}
