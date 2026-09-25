import { Inject, Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';

import { CAPTURE_CLAIM_STALE_MINUTES, IPaymentRepositoryPort, PAYMENT_REPOSITORY } from '../ports';

const MS_PER_MINUTE = 60_000;

@Injectable()
export class ReportStaleCaptureClaimsUseCase {
  constructor(
    @Inject(PAYMENT_REPOSITORY)
    private readonly paymentRepository: IPaymentRepositoryPort,
    @Inject(CAPTURE_CLAIM_STALE_MINUTES)
    private readonly staleMinutes: number,
    @InjectPinoLogger(ReportStaleCaptureClaimsUseCase.name)
    private readonly logger: PinoLogger,
  ) {}

  public async execute(now: Date = new Date()): Promise<number> {
    const olderThan = new Date(now.getTime() - this.staleMinutes * MS_PER_MINUTE);
    const stranded = await this.paymentRepository.listStaleCaptureClaims(olderThan);

    if (stranded.length === 0) {
      return 0;
    }

    for (const payment of stranded) {
      this.logger.error(
        {
          paymentId: payment.id,
          orderId: payment.orderId,
          gatewayReference: payment.gatewayReference,
          amountMinor: payment.amountMinor,
          currency: payment.currency,
          claimedSince: payment.updatedAt,
          staleMinutes: this.staleMinutes,
        },
        'STRANDED CAPTURE CLAIM — a capture died mid-flight and it is unknown whether the money moved. ' +
          'Reconcile against the payment processor by hand; the system will NOT resolve this row, ' +
          'because releasing it risks a second charge and completing it risks recording a charge that never happened.',
      );
    }

    this.logger.error(
      { strandedCount: stranded.length, staleMinutes: this.staleMinutes },
      'Stranded capture claims require manual reconciliation',
    );
    return stranded.length;
  }
}
