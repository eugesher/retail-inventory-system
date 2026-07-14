import { PinoLogger } from 'nestjs-pino';

import { PaymentStatusEnum } from '@retail-inventory-system/contracts';
import { makePinoLoggerMock, PinoLoggerMock } from '@retail-inventory-system/observability/testing';

import { Payment } from '../../../domain';
import { ReportStaleCaptureClaimsUseCase } from '../report-stale-capture-claims.use-case';
import { FakePaymentRepository } from './test-doubles';

const NOW = new Date('2026-07-13T12:00:00Z');
const STALE_MINUTES = 15;

// A payment reconstituted straight into a state, with an explicit `updatedAt` — the horizon is
// measured from it, so the spec must be able to set it.
const paymentAt = (status: PaymentStatusEnum, updatedAt: Date, id: number): Payment =>
  Payment.reconstitute({
    id,
    orderId: 100 + id,
    amountMinor: 29997,
    currency: 'USD',
    method: 'fake-card',
    status,
    gatewayReference: `fake_ref_${id}`,
    authorizedAt: new Date('2026-07-13T10:00:00Z'),
    capturedAt: null,
    updatedAt,
  });

describe('ReportStaleCaptureClaimsUseCase', () => {
  let repository: FakePaymentRepository;
  let logger: PinoLoggerMock;
  let useCase: ReportStaleCaptureClaimsUseCase;

  beforeEach(() => {
    repository = new FakePaymentRepository();
    logger = makePinoLoggerMock();
    useCase = new ReportStaleCaptureClaimsUseCase(
      repository,
      STALE_MINUTES,
      logger as unknown as PinoLogger,
    );
  });

  it('reports nothing when no claim is stranded', async () => {
    await repository.save(
      paymentAt(PaymentStatusEnum.AUTHORIZED, new Date('2026-07-13T09:00:00Z'), 1),
    );

    await expect(useCase.execute(NOW)).resolves.toBe(0);
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('ignores a claim that is younger than the horizon — a capture in flight is not a fault', async () => {
    // Claimed one minute ago: a gateway round-trip is still plausibly in progress.
    await repository.save(
      paymentAt(PaymentStatusEnum.CAPTURING, new Date('2026-07-13T11:59:00Z'), 2),
    );

    await expect(useCase.execute(NOW)).resolves.toBe(0);
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('reports a stranded claim at ERROR, with the gatewayReference an operator needs', async () => {
    await repository.save(
      paymentAt(PaymentStatusEnum.CAPTURING, new Date('2026-07-13T11:00:00Z'), 3),
    );

    await expect(useCase.execute(NOW)).resolves.toBe(1);

    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({
        paymentId: 3,
        orderId: 103,
        // Without this, an operator cannot ask the processor what actually happened — which is the
        // only thing that can resolve the row.
        gatewayReference: 'fake_ref_3',
        claimedSince: new Date('2026-07-13T11:00:00Z'),
      }),
      expect.stringContaining('STRANDED CAPTURE CLAIM'),
    );
  });

  // **The assertion that matters most, and it is an assertion of INACTION.**
  //
  // A sweeper that "resolves" a stranded claim is a sweeper that guesses whether the customer's money
  // moved — and the gateway offers no way to ask. Releasing the claim back to `AUTHORIZED` invites the
  // next caller to charge a second time; completing it to `CAPTURED` records a charge that may never
  // have happened. There is no safe automatic answer, so this use case must not write ANYTHING.
  //
  // Pinning that is the only way it stays true: the next author to read `SweepExpiredReservations…`
  // and reason by analogy will add a fix-it branch, and nothing else in the codebase would stop them.
  it('does NOT resolve the claim — it writes nothing at all', async () => {
    await repository.save(
      paymentAt(PaymentStatusEnum.CAPTURING, new Date('2026-07-13T10:30:00Z'), 4),
    );
    const savesBefore = repository.saveCount;

    await useCase.execute(NOW);

    expect(repository.saveCount).toBe(savesBefore);
    const untouched = await repository.findById(4);
    expect(untouched?.status).toBe(PaymentStatusEnum.CAPTURING);
  });

  it('reports every stranded claim, not just the first', async () => {
    await repository.save(
      paymentAt(PaymentStatusEnum.CAPTURING, new Date('2026-07-13T10:00:00Z'), 5),
    );
    await repository.save(
      paymentAt(PaymentStatusEnum.CAPTURING, new Date('2026-07-13T10:30:00Z'), 6),
    );

    await expect(useCase.execute(NOW)).resolves.toBe(2);
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ strandedCount: 2 }),
      expect.stringContaining('manual reconciliation'),
    );
  });
});
