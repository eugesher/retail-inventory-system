import { PinoLogger } from 'nestjs-pino';

import { bodyFingerprint } from '@retail-inventory-system/common';
import {
  IRetailRefundIssuePayload,
  PaymentStatusEnum,
  RefundStatusEnum,
} from '@retail-inventory-system/contracts';
import { makePinoLoggerMock } from '@retail-inventory-system/observability/testing';

import { OrderErrorCodeEnum, Payment } from '../../../domain';
import { IssueRefundUseCase } from '../issue-refund.use-case';
import {
  buildIdempotencyRecord,
  buildOrderFixture,
  FAKE_CUSTOMER_EMAIL,
  FakeCustomerContactReader,
  FakeIdempotencyStore,
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
  customerContactReader: FakeCustomerContactReader;
  audit: SpyAuditLogPublisher;
  store: FakeIdempotencyStore;
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
  store: FakeIdempotencyStore = new FakeIdempotencyStore(),
): Promise<IHarness> => {
  const logger = makePinoLoggerMock() as unknown as PinoLogger;
  const transactionPort = new FakeTransactionPort();
  const orderRepository = new FakeOrderRepository();
  const paymentRepository = new FakePaymentRepository();
  const refundRepository = new FakeRefundRepository();
  const publisher = new SpyOrderEventsPublisher();
  const customerContactReader = new FakeCustomerContactReader();
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
    customerContactReader,
    audit,
    store,
    logger,
  );

  return {
    useCase,
    paymentRepository,
    refundRepository,
    paymentGateway: gateway,
    publisher,
    customerContactReader,
    audit,
    store,
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

// The canonical body the use case fingerprints — the client-controlled refund command
// (`orderId` / `paymentId` / `amountMinor` / `reason`) minus `correlationId` /
// `idempotencyKey` / the resolved `actorId` (ADR-036). Recomputed here so a seeded record's
// fingerprint matches (a replay) or deliberately diverges (a 422).
const fingerprintOf = (payload: IRetailRefundIssuePayload): string =>
  bodyFingerprint({
    orderId: payload.orderId,
    paymentId: payload.paymentId,
    amountMinor: payload.amountMinor,
    reason: payload.reason,
  });

describe('IssueRefundUseCase', () => {
  it('issues a full refund: flips the payment to refunded, clears the flag, refund issued', async () => {
    const h = await makeHarness(capturedPayment({ flaggedForRefund: true }));

    const { view } = await h.useCase.execute(issuePayload());

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
      // The buyer's email was resolved from the refund's ORDER customerId (the refund event
      // carries none of its own) and stamped on the event (ADR-033); locale ships null.
      customerEmail: FAKE_CUSTOMER_EMAIL,
      customerLocale: null,
    });
    expect(h.customerContactReader.calls).toEqual([OWNER_ID]);
    expect(h.publisher.refundFailed).toHaveLength(0);
  });

  it('issues a partial refund: leaves the payment captured and bumps refundedAmountMinor', async () => {
    const h = await makeHarness();

    const { view } = await h.useCase.execute(issuePayload({ amountMinor: 400 }));

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

    const { view } = await h.useCase.execute(issuePayload());

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

  it('is naturally idempotent: a NEW-key re-issue of the same refund makes only one gateway call', async () => {
    const h = await makeHarness(capturedPayment({ flaggedForRefund: true }));

    const { view: first } = await h.useCase.execute(issuePayload());
    // The second call under a DIFFERENT key is a store miss, so it exercises the natural
    // already-issued guard (not the store replay): the payment is now `refunded`, but the
    // matching `(payment, amount, reason)` short-circuits to the existing refund — no second
    // gateway call, no second audit.
    const { view: second } = await h.useCase.execute(issuePayload({ idempotencyKey: 'idem-2' }));

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

  describe('request-level idempotency (ADR-036)', () => {
    it('replays the stored response before the gateway AND before the audit emit', async () => {
      const store = new FakeIdempotencyStore();
      // A prior refund under the same key + canonical body — its stored RefundView is what
      // the replay must return verbatim.
      const priorView = { id: 555, status: 'issued', amountMinor: CAPTURED_AMOUNT };
      store.seed(
        buildIdempotencyRecord({
          scope: 'issue-refund',
          key: 'idem-1',
          requestFingerprint: fingerprintOf(issuePayload()),
          responseBody: priorView,
        }),
      );
      const h = await makeHarness(capturedPayment(), new FakePaymentGateway(), store);

      const { view, replayed } = await h.useCase.execute(issuePayload());

      expect(replayed).toBe(true);
      expect(view).toEqual(priorView);
      // A replay is side-effect-free — and crucially it does NOT re-audit (no second
      // audit_log_entry), does NOT re-call the gateway, does NOT re-emit, and writes no new
      // refund row or store record.
      expect(h.paymentGateway.refundCount).toBe(0);
      expect(h.audit.events).toHaveLength(0);
      expect(h.publisher.refundIssued).toHaveLength(0);
      expect(h.refundRepository.saveCount).toBe(0);
      expect(h.store.saved).toHaveLength(0);
    });

    it('rejects a reused key with a different body (different fingerprint) as 422', async () => {
      const store = new FakeIdempotencyStore();
      store.seed(
        buildIdempotencyRecord({
          scope: 'issue-refund',
          key: 'idem-1',
          requestFingerprint: 'a-different-body-fingerprint',
        }),
      );
      const h = await makeHarness(capturedPayment(), new FakePaymentGateway(), store);

      await expect(h.useCase.execute(issuePayload())).rejects.toMatchObject({
        code: OrderErrorCodeEnum.ORDER_IDEMPOTENCY_KEY_REUSED,
      });
      // Rejected before any refund work — no gateway call, no audit row.
      expect(h.paymentGateway.refundCount).toBe(0);
      expect(h.audit.events).toHaveLength(0);
    });

    it('rejects a missing Idempotency-Key with ORDER_IDEMPOTENCY_KEY_REQUIRED (400 backstop)', async () => {
      const h = await makeHarness();

      await expect(
        h.useCase.execute(issuePayload({ idempotencyKey: undefined })),
      ).rejects.toMatchObject({ code: OrderErrorCodeEnum.ORDER_IDEMPOTENCY_KEY_REQUIRED });
      expect(h.paymentGateway.refundCount).toBe(0);
    });

    it('persists the stored response after a fresh issue (miss), returned not replayed', async () => {
      const h = await makeHarness();

      const { view, replayed } = await h.useCase.execute(issuePayload());

      expect(replayed).toBe(false);
      // The refund ran (a fresh execution): one gateway call, one audit row.
      expect(h.paymentGateway.refundCount).toBe(1);
      expect(h.audit.events).toHaveLength(1);
      // The record was stored under (issue-refund, key) with the fingerprint + the RefundView
      // body + the 201 success status.
      expect(h.store.saved).toHaveLength(1);
      expect(h.store.saved[0]).toMatchObject({
        scope: 'issue-refund',
        key: 'idem-1',
        requestFingerprint: fingerprintOf(issuePayload()),
        responseStatus: 201,
      });
      expect((h.store.saved[0].responseBody as { id?: number }).id).toBe(view.id);
    });

    it('converges on the concurrent winner: a duplicate save falls back to the stored winner as a replay', async () => {
      const store = new FakeIdempotencyStore();
      // A simultaneous identical refund committed + stored first (a DISTINCT stored body). It
      // is hidden from our first lookup (the miss) and revealed on the post-save re-read.
      const winnerView = { id: 999, status: 'issued', amountMinor: CAPTURED_AMOUNT };
      store.armConcurrentWinner(
        buildIdempotencyRecord({
          scope: 'issue-refund',
          key: 'idem-1',
          requestFingerprint: fingerprintOf(issuePayload()),
          responseBody: winnerView,
        }),
      );
      const h = await makeHarness(capturedPayment(), new FakePaymentGateway(), store);

      const { view, replayed } = await h.useCase.execute(issuePayload());

      // Our save lost the composite-PK race, so the winner's stored response is returned as
      // a replay — the two racers converge on one response.
      expect(replayed).toBe(true);
      expect(view).toEqual(winnerView);
      expect(h.store.saved).toHaveLength(1);
    });
  });
});
