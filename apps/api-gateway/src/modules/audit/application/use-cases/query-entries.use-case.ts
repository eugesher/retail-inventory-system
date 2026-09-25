import { Inject, Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';

import { AuditLogEntryView, IPage } from '@retail-inventory-system/contracts';

import { throwRpcError } from '../../../../common/utils';
import { AUDIT_GATEWAY_PORT, IAuditGatewayPort, IQueryEntriesQuery } from '../ports';

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
