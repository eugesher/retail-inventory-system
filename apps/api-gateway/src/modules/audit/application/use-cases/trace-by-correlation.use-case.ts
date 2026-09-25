import { Inject, Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';

import { ICorrelationTraceResult } from '@retail-inventory-system/contracts';

import { throwRpcError } from '../../../../common/utils';
import { AUDIT_GATEWAY_PORT, IAuditGatewayPort, ITraceByCorrelationQuery } from '../ports';

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
