import { Inject, Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';

import { ICorrelationTraceResult } from '@retail-inventory-system/contracts';

import { throwRpcError } from '../../../../common/utils';
import { AUDIT_GATEWAY_PORT, IAuditGatewayPort, ITraceByCorrelationQuery } from '../ports';

// Thin gateway-side orchestrator over the `audit.trace.by-correlation` RPC — the causal
// chain of one request across every service that touched it, reassembled from the two
// event-store logs by a single correlation id (ADR-039).
//
// TWO correlation ids meet here and never merge:
//   - `correlationId`             — the trace id of the request asking the question,
//                                   threaded by `CorrelationMiddleware`;
//   - `query.targetCorrelationId` — the id being traced.
// They occupy different fields on the wire payload, and both are logged, so a support
// query is itself traceable against the chain it went looking for.
//
// An unknown target yields two empty arrays with a `200`. The absence of a trace is not
// the absence of a resource, so there is no `404` path here.
@Injectable()
export class TraceByCorrelationUseCase {
  constructor(
    @Inject(AUDIT_GATEWAY_PORT)
    private readonly auditGateway: IAuditGatewayPort,
    @InjectPinoLogger(TraceByCorrelationUseCase.name)
    private readonly logger: PinoLogger,
  ) {}

  public async execute(
    query: ITraceByCorrelationQuery,
    correlationId: string,
  ): Promise<ICorrelationTraceResult> {
    this.logger.assign({ correlationId });

    try {
      this.logger.info(
        { targetCorrelationId: query.targetCorrelationId },
        'Tracing by correlation id',
      );

      const result = await this.auditGateway.traceByCorrelation({ ...query, correlationId });

      this.logger.info(
        {
          targetCorrelationId: query.targetCorrelationId,
          events: result.events.length,
          auditEntries: result.auditEntries.length,
        },
        'Correlation trace assembled',
      );

      return result;
    } catch (error) {
      this.logger.error(error, 'Error tracing by correlation id');

      throwRpcError(error);
    }
  }
}
