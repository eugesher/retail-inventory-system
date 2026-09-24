import { PinoLogger } from 'nestjs-pino';

import { PaymentStatusEnum } from '@retail-inventory-system/contracts';
import { makePinoLoggerMock, PinoLoggerMock } from '@retail-inventory-system/observability/testing';

import { Payment } from '../../../domain';
import { ReportStaleCaptureClaimsUseCase } from '../report-stale-capture-claims.use-case';
import { FakePaymentRepository } from './test-doubles';

const NOW = new Date('2026-07-13T12:00:00Z');
const STALE_MINUTES = 15;

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
        gatewayReference: 'fake_ref_3',
        claimedSince: new Date('2026-07-13T11:00:00Z'),
      }),
      expect.stringContaining('STRANDED CAPTURE CLAIM'),
    );
  });

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
