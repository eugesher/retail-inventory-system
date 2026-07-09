import { Inject, Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';

import { AuditLogEntryView, IPage } from '@retail-inventory-system/contracts';

import { throwRpcError } from '../../../../common/utils';
import { AUDIT_GATEWAY_PORT, IAuditGatewayPort, IQueryEntriesQuery } from '../ports';

// Thin gateway-side orchestrator over the `audit.entry.query` RPC — the operator read
// of the event store's append-only `audit_log_entry` staff trail. The filtering, the
// paging, the 1..100 page-size clamp, and the newest-first ordering are the event
// store's responsibility; the gateway folds the request's correlation id onto the wire
// payload and maps any downstream rejection onto the right HTTP status via
// `throwRpcError`.
//
// The `action` filter matches the stable event-name string an audit row carries
// (`RefundIssued`, `StaffUserRolesAssigned`), never a permission code — the ingest maps
// `action ← IAuditLogEvent.name` (ADR-035).
@Injectable()
export class QueryEntriesUseCase {
  constructor(
    @Inject(AUDIT_GATEWAY_PORT)
    private readonly auditGateway: IAuditGatewayPort,
    @InjectPinoLogger(QueryEntriesUseCase.name)
    private readonly logger: PinoLogger,
  ) {}

  public async execute(
    query: IQueryEntriesQuery,
    correlationId: string,
  ): Promise<IPage<AuditLogEntryView>> {
    this.logger.assign({ correlationId });

    try {
      this.logger.info(
        { filters: query.filters, page: query.page, pageSize: query.pageSize },
        'Querying audit log entries',
      );

      // `correlationId` here is the id of THIS request; `query.filters.correlationId`,
      // if present, is the id being searched for. Two fields, never one.
      const result = await this.auditGateway.queryEntries({ ...query, correlationId });

      this.logger.info(
        { total: result.total, returned: result.items.length },
        'Audit log entries queried',
      );

      return result;
    } catch (error) {
      this.logger.error(error, 'Error querying audit log entries');

      throwRpcError(error);
    }
  }
}
