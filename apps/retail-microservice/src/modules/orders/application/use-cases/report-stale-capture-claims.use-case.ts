import { Inject, Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';

import { CAPTURE_CLAIM_STALE_MINUTES, IPaymentRepositoryPort, PAYMENT_REPOSITORY } from '../ports';

const MS_PER_MINUTE = 60_000;

// The stranded-claim report (ADR-052).
//
// A `CAPTURING` payment is a caller saying *"I am about to charge this authorization"* — written under
// a row lock and committed **before** the gateway call, so that the loser of a race is refused and a
// crash leaves evidence rather than silence. The happy paths resolve it in a gateway round-trip:
// `completeCapture` on approval, `releaseCapture` on decline.
//
// **A claim that is still open minutes later belongs to a request that died mid-charge — and NOBODY
// KNOWS WHETHER THE MONEY MOVED.** `IPaymentGatewayPort` offers `authorize` / `capture` / `refund` and
// no way to ask *"did my capture land?"*.
//
// **So this use case does not resolve anything, and that is the design, not a shortcut.**
//
// - Releasing the claim back to `AUTHORIZED` would let the next caller charge again — recreating the
//   double charge this whole mechanism exists to prevent, and doing it *deliberately*.
// - Completing it to `CAPTURED` would record money that may never have moved, and hand the customer a
//   refund claim against a charge that does not exist.
//
// There is no safe automatic answer, so the system does not invent one. It **reports**, at `error`, one
// line per stranded row, with the `gatewayReference` an operator needs to look it up at the processor.
// That is the whole job: a `PENDING` refund row buys exactly the same thing today (ADR-032) — evidence
// a human can act on, instead of a silent inconsistency nobody knows exists.
//
// **This is what a "sweeper" honestly is here.** It is named `Report…`, not `Sweep…`, so nobody adds a
// fix-it branch to it by analogy with `SweepExpiredReservationsUseCase` — that one releases holds on
// stock, where a wrong guess costs availability. This one guards money, where a wrong guess costs a
// customer twice.
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

  // `now` is a parameter, not `new Date()` inline, so a test can drive the horizon deterministically
  // (the `SweepExpiredReservationsUseCase` precedent). Returns the count so a caller can assert on it.
  public async execute(now: Date = new Date()): Promise<number> {
    const olderThan = new Date(now.getTime() - this.staleMinutes * MS_PER_MINUTE);
    const stranded = await this.paymentRepository.listStaleCaptureClaims(olderThan);

    if (stranded.length === 0) {
      return 0;
    }

    // `error`, not `warn`: every one of these is a payment whose fate is unknown, and an operator has
    // to reconcile it against the processor by hand. It is not a degraded mode to be tolerated.
    for (const payment of stranded) {
      this.logger.error(
        {
          paymentId: payment.id,
          orderId: payment.orderId,
          // The handle an operator needs to ask the processor what actually happened.
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
