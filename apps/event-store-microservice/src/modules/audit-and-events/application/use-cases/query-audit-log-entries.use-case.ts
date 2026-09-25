import { Inject, Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';

import { clampPageWindow } from '@retail-inventory-system/common';
import {
  AuditLogEntryView,
  IAuditLogQueryPayload,
  IPage,
} from '@retail-inventory-system/contracts';

import { AUDIT_LOG_REPOSITORY, IAuditLogRepositoryPort } from '../ports';
import { toAuditLogEntryView } from './audit-log-entry-view.factory';

@Injectable()
export class QueryAuditLogEntriesUseCase {
  constructor(
    @Inject(AUDIT_LOG_REPOSITORY)
    private readonly repository: IAuditLogRepositoryPort,
    @InjectPinoLogger(QueryAuditLogEntriesUseCase.name)
    private readonly logger: PinoLogger,
  ) {}

  public async execute(payload: IAuditLogQueryPayload): Promise<IPage<AuditLogEntryView>> {
    const { correlationId } = payload;
    const filters = payload.filters ?? {};

    const { page, size } = clampPageWindow(payload.page, payload.pageSize, {
      defaultPage: 1,
      defaultSize: 20,
      maxSize: 100,
    });

    this.logger.info(
      { correlationId, filters, page, size },
      'Received RPC: query audit log entries (staff audit read)',
    );

    const entriesPage = await this.repository.query(filters, { page, size });

    return {
      items: entriesPage.items.map(toAuditLogEntryView),
      total: entriesPage.total,
      page: entriesPage.page,
      size: entriesPage.size,
    };
  }
}
