import { Inject, Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';

import { DomainEventView, IPage } from '@retail-inventory-system/contracts';

import { throwRpcError } from '../../../../common/utils';
import { AUDIT_GATEWAY_PORT, IAuditGatewayPort, IQueryEventsQuery } from '../ports';

// Thin gateway-side orchestrator over the `audit.event.query` RPC — the operator read
// of the event store's append-only `domain_event` firehose log. The filtering, the
// paging, the 1..100 page-size clamp, and the newest-first ordering are the event
// store's responsibility; the gateway folds the request's correlation id onto the wire
// payload and maps any downstream rejection onto the right HTTP status via
// `throwRpcError`.
//
// An unmatched filter set is a `200` empty page, not an error — including an inverted
// `from`/`to` window, which the DTO has already rejected with a `400` before it can
// reach here.
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

      // `correlationId` here is the id of THIS request; `query.filters.correlationId`,
      // if present, is the id being searched for. Two fields, never one.
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
