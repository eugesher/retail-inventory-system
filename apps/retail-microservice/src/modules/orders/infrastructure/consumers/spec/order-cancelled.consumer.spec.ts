import { PinoLogger } from 'nestjs-pino';

import {
  IRetailOrderCancelledEvent,
  IRetailRefundIssuePayload,
  PaymentStatusEnum,
  RefundView,
} from '@retail-inventory-system/contracts';
import { makePinoLoggerMock } from '@retail-inventory-system/observability/testing';

import { Payment } from '../../../domain';
import { IssueRefundUseCase } from '../../../application/use-cases';
import { FakePaymentRepository } from '../../../application/use-cases/spec/test-doubles';
import { OrderCancelledConsumer } from '../order-cancelled.consumer';

const ORDER_ID = 7;
const PAYMENT_ID = 70;
const CAPTURED_AMOUNT = 2500;
const CORRELATION = 'corr-cancel-1';

// A captured payment with tunable refund accounting — the idempotency case needs a
// fully-refunded payment (`refundedAmountMinor === amountMinor`, status `refunded`).
const capturedPayment = (
  opts: { status?: PaymentStatusEnum; refundedAmountMinor?: number } = {},
): Payment =>
  Payment.reconstitute({
    id: PAYMENT_ID,
    orderId: ORDER_ID,
    amountMinor: CAPTURED_AMOUNT,
    currency: 'USD',
    method: 'fake-card',
    status: opts.status ?? PaymentStatusEnum.CAPTURED,
    gatewayReference: 'fake_charge_70',
    authorizedAt: new Date('2026-06-10T00:00:00.000Z'),
    capturedAt: new Date('2026-06-11T00:00:00.000Z'),
    flaggedForRefund: opts.status === PaymentStatusEnum.REFUNDED ? false : true,
    refundedAmountMinor: opts.refundedAmountMinor ?? 0,
  });

const cancelledEvent = (
  overrides: Partial<IRetailOrderCancelledEvent> = {},
): IRetailOrderCancelledEvent => ({
  orderId: ORDER_ID,
  cancelledAt: '2026-06-12T00:00:00.000Z',
  reason: 'customer-changed-mind',
  paymentFlaggedForRefund: true,
  eventVersion: 'v1',
  occurredAt: '2026-06-12T00:00:00.000Z',
  correlationId: CORRELATION,
  ...overrides,
});

interface IHarness {
  consumer: OrderCancelledConsumer;
  execute: jest.Mock<Promise<RefundView>, [IRetailRefundIssuePayload]>;
  paymentRepository: FakePaymentRepository;
}

const makeHarness = async (payment: Payment | null = capturedPayment()): Promise<IHarness> => {
  const logger = makePinoLoggerMock() as unknown as PinoLogger;
  const paymentRepository = new FakePaymentRepository();
  if (payment) {
    await paymentRepository.save(payment);
  }

  // The `IssueRefundUseCase` double — a jest spy whose resolved value the consumer ignores
  // (it only awaits the call). Cast through `unknown` so the spy satisfies the concrete
  // constructor parameter type without re-implementing the whole class.
  const execute = jest
    .fn<Promise<RefundView>, [IRetailRefundIssuePayload]>()
    .mockResolvedValue({} as RefundView);
  const issueRefund = { execute } as unknown as IssueRefundUseCase;

  const consumer = new OrderCancelledConsumer(issueRefund, paymentRepository, logger);
  return { consumer, execute, paymentRepository };
};

describe('OrderCancelledConsumer', () => {
  it('issues a full refund for the refundable remainder when the payment is flagged', async () => {
    const h = await makeHarness();

    await h.consumer.onOrderCancelled(cancelledEvent());

    expect(h.execute).toHaveBeenCalledTimes(1);
    expect(h.execute).toHaveBeenCalledWith({
      orderId: ORDER_ID,
      paymentId: PAYMENT_ID,
      amountMinor: CAPTURED_AMOUNT,
      reason: 'order-cancelled',
      actorId: null,
      correlationId: CORRELATION,
    });
  });

  it('refunds only the still-refundable remainder when a partial refund already happened', async () => {
    const h = await makeHarness(capturedPayment({ refundedAmountMinor: 1000 }));

    await h.consumer.onOrderCancelled(cancelledEvent());

    expect(h.execute).toHaveBeenCalledTimes(1);
    expect(h.execute).toHaveBeenCalledWith(
      expect.objectContaining({ amountMinor: CAPTURED_AMOUNT - 1000 }),
    );
  });

  it('is a no-op when the payment is not flagged for refund (a pre-capture cancel)', async () => {
    const h = await makeHarness();

    await h.consumer.onOrderCancelled(cancelledEvent({ paymentFlaggedForRefund: false }));

    expect(h.execute).not.toHaveBeenCalled();
  });

  it('is a no-op on redelivery after a full refund (refundable === 0, idempotent)', async () => {
    // The payment is already `refunded` with the whole capture accounted for, so the
    // refundable remainder is 0 — exactly the at-least-once redelivery the flag + accounting
    // make idempotent without a processed-message store.
    const h = await makeHarness(
      capturedPayment({
        status: PaymentStatusEnum.REFUNDED,
        refundedAmountMinor: CAPTURED_AMOUNT,
      }),
    );

    await h.consumer.onOrderCancelled(cancelledEvent());

    expect(h.execute).not.toHaveBeenCalled();
  });

  it('is a no-op when the flagged order has no payment row (defensive)', async () => {
    const h = await makeHarness(null);

    await expect(h.consumer.onOrderCancelled(cancelledEvent())).resolves.toBeUndefined();
    expect(h.execute).not.toHaveBeenCalled();
  });

  it('swallows a downstream refund failure (best-effort — never throws out of the handler)', async () => {
    const h = await makeHarness();
    h.execute.mockRejectedValueOnce(new Error('gateway unreachable'));

    // The cancel already committed and the payment stays flagged for a manual retry, so the
    // consumer must not throw (a throw would NACK/redeliver pointlessly).
    await expect(h.consumer.onOrderCancelled(cancelledEvent())).resolves.toBeUndefined();
    expect(h.execute).toHaveBeenCalledTimes(1);
  });
});
