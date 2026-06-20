import { PinoLogger } from 'nestjs-pino';

import {
  IRetailRefundIssuePayload,
  PaymentStatusEnum,
  RefundStatusEnum,
} from '@retail-inventory-system/contracts';
import { makePinoLoggerMock } from '@retail-inventory-system/observability/testing';

import { OrderErrorCodeEnum, Payment } from '../../../domain';
import { IssueRefundUseCase } from '../issue-refund.use-case';
import {
  buildOrderFixture,
  FakeOrderRepository,
  FakePaymentGateway,
  FakePaymentRepository,
  FakeRefundRepository,
  FakeTransactionPort,
  SpyAuditLogPublisher,
  SpyOrderEventsPublisher,
} from './test-doubles';

const STAFF_ID = '00000000-0000-4000-a000-000000000010';
const OWNER_ID = '00000000-0000-4000-a000-000000000002';
const ORDER_ID = 1;
const PAYMENT_ID = 1;
const CAPTURED_AMOUNT = 1000;

interface IHarness {
  useCase: IssueRefundUseCase;
  paymentRepository: FakePaymentRepository;
  refundRepository: FakeRefundRepository;
  paymentGateway: FakePaymentGateway;
  publisher: SpyOrderEventsPublisher;
  audit: SpyAuditLogPublisher;
}

// Builds a captured payment with tunable refund accounting (the refundable ceiling +
// flag-clear cases need a pre-refunded / pre-flagged payment).
const capturedPayment = (
  opts: { refundedAmountMinor?: number; flaggedForRefund?: boolean } = {},
): Payment =>
  Payment.reconstitute({
    id: PAYMENT_ID,
    orderId: ORDER_ID,
    amountMinor: CAPTURED_AMOUNT,
    currency: 'USD',
    method: 'fake-card',
    status: PaymentStatusEnum.CAPTURED,
    gatewayReference: 'fake_charge_1',
    authorizedAt: new Date('2026-06-10T00:00:00.000Z'),
    capturedAt: new Date('2026-06-11T00:00:00.000Z'),
    flaggedForRefund: opts.flaggedForRefund ?? false,
    refundedAmountMinor: opts.refundedAmountMinor ?? 0,
  });

const makeHarness = async (
  payment: Payment = capturedPayment(),
  gateway: FakePaymentGateway = new FakePaymentGateway(),
): Promise<IHarness> => {
  const logger = makePinoLoggerMock() as unknown as PinoLogger;
  const transactionPort = new FakeTransactionPort();
  const orderRepository = new FakeOrderRepository();
  const paymentRepository = new FakePaymentRepository();
  const refundRepository = new FakeRefundRepository();
  const publisher = new SpyOrderEventsPublisher();
  const audit = new SpyAuditLogPublisher();

  await orderRepository.save(buildOrderFixture(ORDER_ID, OWNER_ID));
  await paymentRepository.save(payment);

  const useCase = new IssueRefundUseCase(
    transactionPort,
    gateway,
    orderRepository,
    paymentRepository,
    refundRepository,
    publisher,
    audit,
    logger,
  );

  return {
    useCase,
    paymentRepository,
    refundRepository,
    paymentGateway: gateway,
    publisher,
    audit,
  };
};

const issuePayload = (
  overrides: Partial<IRetailRefundIssuePayload> = {},
): IRetailRefundIssuePayload => ({
  orderId: ORDER_ID,
  paymentId: PAYMENT_ID,
  amountMinor: CAPTURED_AMOUNT,
  reason: 'customer-return',
  actorId: STAFF_ID,
  idempotencyKey: 'idem-1',
  correlationId: 'corr-1',
  ...overrides,
});

describe('IssueRefundUseCase', () => {
  it('issues a full refund: flips the payment to refunded, clears the flag, refund issued', async () => {
    const h = await makeHarness(capturedPayment({ flaggedForRefund: true }));

    const view = await h.useCase.execute(issuePayload());

    expect(view.status).toBe(RefundStatusEnum.ISSUED);
    expect(view.amountMinor).toBe(CAPTURED_AMOUNT);
    expect(view.gatewayReference).toMatch(/^fake_refund_/);
    expect(view.issuedAt).toEqual(expect.any(String));
    expect(h.paymentGateway.refundCount).toBe(1);

    // The payment is fully refunded — status flips and the refund flag clears.
    const payment = await h.paymentRepository.findByOrderId(ORDER_ID);
    expect(payment?.status).toBe(PaymentStatusEnum.REFUNDED);
    expect(payment?.refundedAmountMinor).toBe(CAPTURED_AMOUNT);
    expect(payment?.flaggedForRefund).toBe(false);

    // The buyer-facing issued event fired.
    expect(h.publisher.refundIssued).toHaveLength(1);
    expect(h.publisher.refundIssued[0]).toMatchObject({
      orderId: ORDER_ID,
      paymentId: PAYMENT_ID,
      amountMinor: CAPTURED_AMOUNT,
      eventVersion: 'v1',
    });
    expect(h.publisher.refundFailed).toHaveLength(0);
  });

  it('issues a partial refund: leaves the payment captured and bumps refundedAmountMinor', async () => {
    const h = await makeHarness();

    const view = await h.useCase.execute(issuePayload({ amountMinor: 400 }));

    expect(view.status).toBe(RefundStatusEnum.ISSUED);
    expect(view.amountMinor).toBe(400);

    const payment = await h.paymentRepository.findByOrderId(ORDER_ID);
    expect(payment?.status).toBe(PaymentStatusEnum.CAPTURED);
    expect(payment?.refundedAmountMinor).toBe(400);
  });

  it('accumulates the ceiling across partial refunds, then rejects an over-refund', async () => {
    // 700 already refunded — only 300 remains.
    const h = await makeHarness(capturedPayment({ refundedAmountMinor: 700 }));

    await expect(h.useCase.execute(issuePayload({ amountMinor: 400 }))).rejects.toMatchObject({
      code: OrderErrorCodeEnum.REFUND_EXCEEDS_REFUNDABLE,
    });
    // The ceiling is checked before the gateway is touched and before any row is written.
    expect(h.paymentGateway.refundCount).toBe(0);
    expect(h.refundRepository.saveCount).toBe(0);
  });

  it('rejects a refund against a non-captured (authorized) payment', async () => {
    const authorized = Payment.reconstitute({
      id: PAYMENT_ID,
      orderId: ORDER_ID,
      amountMinor: CAPTURED_AMOUNT,
      currency: 'USD',
      method: 'fake-card',
      status: PaymentStatusEnum.AUTHORIZED,
      gatewayReference: 'fake_charge_1',
      authorizedAt: new Date('2026-06-10T00:00:00.000Z'),
      capturedAt: null,
    });
    const h = await makeHarness(authorized);

    await expect(h.useCase.execute(issuePayload())).rejects.toMatchObject({
      code: OrderErrorCodeEnum.REFUND_PAYMENT_NOT_CAPTURED,
    });
    expect(h.paymentGateway.refundCount).toBe(0);
  });

  it('records a failed refund on a gateway decline, leaving the payment unchanged', async () => {
    // refundOk = false arms the decline.
    const decliningGateway = new FakePaymentGateway(true, true, false);
    const h = await makeHarness(capturedPayment(), decliningGateway);

    const view = await h.useCase.execute(issuePayload());

    expect(view.status).toBe(RefundStatusEnum.FAILED);
    expect(view.gatewayReference).toBeNull();

    // The payment never accumulated anything.
    const payment = await h.paymentRepository.findByOrderId(ORDER_ID);
    expect(payment?.status).toBe(PaymentStatusEnum.CAPTURED);
    expect(payment?.refundedAmountMinor).toBe(0);

    // The failed event fired (onto retail_queue), not the issued one.
    expect(h.publisher.refundFailed).toHaveLength(1);
    expect(h.publisher.refundFailed[0]).toMatchObject({ orderId: ORDER_ID, eventVersion: 'v1' });
    expect(h.publisher.refundIssued).toHaveLength(0);
  });

  it('always audits the money movement with a before/after payment snapshot', async () => {
    const h = await makeHarness(capturedPayment({ flaggedForRefund: true }));

    await h.useCase.execute(issuePayload());

    expect(h.audit.events).toHaveLength(1);
    const event = h.audit.events[0];
    expect(event.name).toBe('RefundIssued');
    expect(event.actorId).toBe(STAFF_ID);
    expect(event.payload).toMatchObject({
      orderId: ORDER_ID,
      paymentId: PAYMENT_ID,
      amountMinor: CAPTURED_AMOUNT,
      reason: 'customer-return',
      paymentStatusBefore: PaymentStatusEnum.CAPTURED,
      paymentStatusAfter: PaymentStatusEnum.REFUNDED,
      refundedAmountMinorBefore: 0,
      refundedAmountMinorAfter: CAPTURED_AMOUNT,
    });
  });

  it('audits a declined refund too (before === after, payment unchanged)', async () => {
    const decliningGateway = new FakePaymentGateway(true, true, false);
    const h = await makeHarness(capturedPayment(), decliningGateway);

    await h.useCase.execute(issuePayload());

    expect(h.audit.events).toHaveLength(1);
    expect(h.audit.events[0].name).toBe('RefundFailed');
    expect(h.audit.events[0].payload).toMatchObject({
      paymentStatusBefore: PaymentStatusEnum.CAPTURED,
      paymentStatusAfter: PaymentStatusEnum.CAPTURED,
      refundedAmountMinorBefore: 0,
      refundedAmountMinorAfter: 0,
    });
  });

  it('is idempotent: re-issuing the same refund makes only one gateway call', async () => {
    const h = await makeHarness(capturedPayment({ flaggedForRefund: true }));

    const first = await h.useCase.execute(issuePayload());
    // The second call replays the same (payment, amount, reason) — the payment is now
    // `refunded`, but the natural-idempotency guard short-circuits to the existing refund.
    const second = await h.useCase.execute(issuePayload());

    expect(first.id).toBe(second.id);
    expect(second.status).toBe(RefundStatusEnum.ISSUED);
    // Only one gateway call, one issued event, one audit row.
    expect(h.paymentGateway.refundCount).toBe(1);
    expect(h.publisher.refundIssued).toHaveLength(1);
    expect(h.audit.events).toHaveLength(1);
  });

  it('rejects a refund for an unknown order with ORDER_NOT_FOUND', async () => {
    const h = await makeHarness();

    await expect(h.useCase.execute(issuePayload({ orderId: 999 }))).rejects.toMatchObject({
      code: OrderErrorCodeEnum.ORDER_NOT_FOUND,
    });
    expect(h.paymentGateway.refundCount).toBe(0);
  });

  it('rejects a refund when the order has no matching payment', async () => {
    const h = await makeHarness();

    await expect(h.useCase.execute(issuePayload({ paymentId: 999 }))).rejects.toMatchObject({
      code: OrderErrorCodeEnum.REFUND_PAYMENT_NOT_CAPTURED,
    });
    expect(h.paymentGateway.refundCount).toBe(0);
  });
});
