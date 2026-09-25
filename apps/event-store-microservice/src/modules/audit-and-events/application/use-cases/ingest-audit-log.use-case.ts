import { Inject, Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';

import { IAuditStaffActionEvent } from '@retail-inventory-system/contracts';

import { AUDIT_ACTOR_TYPES, AuditLogEntry } from '../../domain';
import { AUDIT_LOG_REPOSITORY, IAuditLogRepositoryPort } from '../ports';

@Injectable()
export class IngestAuditLogUseCase {
  constructor(
    @Inject(AUDIT_LOG_REPOSITORY)
    private readonly repository: IAuditLogRepositoryPort,
    @InjectPinoLogger(IngestAuditLogUseCase.name)
    private readonly logger: PinoLogger,
  ) {}

  public async execute(event: IAuditStaffActionEvent): Promise<void> {
    const correlationId = event.correlationId ?? '';

    if (!AUDIT_ACTOR_TYPES.includes(event.actorType)) {
      this.logger.warn(
        { correlationId, action: event.action, actorType: event.actorType },
        'Dropping audit event — unknown actorType',
      );
      return;
    }

    const occurredAt = this.parseOccurredAt(event.occurredAt);
    if (occurredAt === null) {
      this.logger.warn(
        { correlationId, action: event.action, occurredAt: event.occurredAt },
        'Dropping audit event — missing or invalid occurredAt',
      );
      return;
    }

    try {
      const entry = AuditLogEntry.create({
        actorId: event.actorId,
        actorType: event.actorType,
        action: event.action,
        entityType: event.entityType,
        entityId: event.entityId,
        before: event.before,
        after: event.after,
        occurredAt,
        ipAddress: event.ipAddress,
        correlationId,
      });

      await this.repository.append(entry);

      this.logger.debug(
        { correlationId, action: event.action, actorId: event.actorId },
        'Audit entry appended to audit_log_entry',
      );
    } catch (error) {
      this.logger.warn(
        { err: error as Error, correlationId, action: event.action },
        'Failed to ingest audit event — dropping message',
      );
    }
  }

  private parseOccurredAt(raw: unknown): Date | null {
    if (typeof raw !== 'string' || raw.length === 0) {
      return null;
    }
    const date = new Date(raw);
    return Number.isNaN(date.getTime()) ? null : date;
  }
}
