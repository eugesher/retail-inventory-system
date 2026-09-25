import { Inject, Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';

import { DomainEventView, IPage } from '@retail-inventory-system/contracts';

import { throwRpcError } from '../../../../common/utils';
import { AUDIT_GATEWAY_PORT, IAuditGatewayPort, IQueryEventsQuery } from '../ports';

@Injectable()
export class QueryEventsUseCase {
  constructor(
    @Inject(AUDIT_GATEWAY_PORT)
    private readonly auditGateway: IAuditGatewayPort,
    @InjectPinoLogger(QueryEventsUseCase.name)
    private readonly logger: PinoLogger,
  ) {}

  public async execute(
    query: IQueryEventsQuery,
    correlationId: string,
  ): Promise<IPage<DomainEventView>> {
    this.logger.assign({ correlationId });

    try {
      this.logger.info(
        { filters: query.filters, page: query.page, pageSize: query.pageSize },
        'Querying domain events',
      );

      const result = await this.auditGateway.queryEvents({ ...query, correlationId });

      this.logger.info(
        { total: result.total, returned: result.items.length },
        'Domain events queried',
      );

      return result;
    } catch (error) {
      this.logger.error(error, 'Error querying domain events');

      throwRpcError(error);
    }
  }
}
