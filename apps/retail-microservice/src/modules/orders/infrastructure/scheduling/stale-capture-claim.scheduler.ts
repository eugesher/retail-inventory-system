import { Injectable } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';

import { ReportStaleCaptureClaimsUseCase } from '../../application/use-cases';

@Injectable()
export class StaleCaptureClaimScheduler {
  constructor(
    private readonly report: ReportStaleCaptureClaimsUseCase,
    @InjectPinoLogger(StaleCaptureClaimScheduler.name)
    private readonly logger: PinoLogger,
  ) {}

  @Cron(CronExpression.EVERY_10_MINUTES, { name: 'stale-capture-claim-report' })
  public async sweep(): Promise<void> {
    try {
      await this.report.execute();
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      this.logger.warn({ reason }, 'Stale capture claim report failed');
    }
  }
}
