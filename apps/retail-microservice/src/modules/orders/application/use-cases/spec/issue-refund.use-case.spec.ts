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

    const payment = await h.paymentRepository.findByOrderId(ORDER_ID);
    expect(payment?.status).toBe(PaymentStatusEnum.REFUNDED);
    expect(payment?.refundedAmountMinor).toBe(CAPTURED_AMOUNT);
    expect(payment?.flaggedForRefund).toBe(false);

    expect(h.publisher.refundIssued).toHaveLength(1);
    expect(h.publisher.refundIssued[0]).toMatchObject({
      orderId: ORDER_ID,
      paymentId: PAYMENT_ID,
      amountMinor: CAPTURED_AMOUNT,
      eventVersion: 'v1',
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
    const h = await makeHarness(capturedPayment({ refundedAmountMinor: 700 }));

    await expect(h.useCase.execute(issuePayload({ amountMinor: 400 }))).rejects.toMatchObject({
      code: OrderErrorCodeEnum.REFUND_EXCEEDS_REFUNDABLE,
    });
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
    const decliningGateway = new FakePaymentGateway(true, true, false);
    const h = await makeHarness(capturedPayment(), decliningGateway);

    const { view } = await h.useCase.execute(issuePayload());

    expect(view.status).toBe(RefundStatusEnum.FAILED);
    expect(view.gatewayReference).toBeNull();

    const payment = await h.paymentRepository.findByOrderId(ORDER_ID);
    expect(payment?.status).toBe(PaymentStatusEnum.CAPTURED);
    expect(payment?.refundedAmountMinor).toBe(0);

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
    const { view: second } = await h.useCase.execute(issuePayload({ idempotencyKey: 'idem-2' }));

    expect(first.id).toBe(second.id);
    expect(second.status).toBe(RefundStatusEnum.ISSUED);
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
      expect(h.paymentGateway.refundCount).toBe(0);
      expect(h.audit.events).toHaveLength(0);
      expect(h.publisher.refundIssued).toHaveLength(0);
      expect(h.refundRepository.saveCount).toBe(0);
      expect(h.store.finalized).toHaveLength(0);
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

    it('reserves the key then finalizes the stored response after a fresh issue (miss), returned not replayed', async () => {
      const h = await makeHarness();

      const { view, replayed } = await h.useCase.execute(issuePayload());

      expect(replayed).toBe(false);
      expect(h.paymentGateway.refundCount).toBe(1);
      expect(h.audit.events).toHaveLength(1);
      expect(h.store.reserved).toHaveLength(1);
      expect(h.store.reserved[0]).toMatchObject({
        scope: 'issue-refund',
        key: 'idem-1',
        requestFingerprint: fingerprintOf(issuePayload()),
      });
      expect(h.store.finalized).toHaveLength(1);
      expect(h.store.finalized[0]).toMatchObject({
        scope: 'issue-refund',
        key: 'idem-1',
        responseStatus: 201,
      });
      expect((h.store.finalized[0].responseBody as { id?: number }).id).toBe(view.id);
      expect(h.store.released).toHaveLength(0);
    });

    it('turns away a concurrent same-key submit (in-flight reservation) with 409 IN_PROGRESS, no second refund', async () => {
      const store = new FakeIdempotencyStore();
      await store.reserve({
        scope: 'issue-refund',
        key: 'idem-1',
        requestFingerprint: fingerprintOf(issuePayload()),
      });
      const h = await makeHarness(capturedPayment(), new FakePaymentGateway(), store);

      await expect(h.useCase.execute(issuePayload())).rejects.toMatchObject({
        code: OrderErrorCodeEnum.ORDER_IDEMPOTENCY_KEY_IN_PROGRESS,
      });
      expect(h.paymentGateway.refundCount).toBe(0);
      expect(h.audit.events).toHaveLength(0);
    });

    it('replays a concurrent winner that already completed under the same key + body', async () => {
      const store = new FakeIdempotencyStore();
      const winnerView = { id: 999, status: 'issued', amountMinor: CAPTURED_AMOUNT };
      store.seed(
        buildIdempotencyRecord({
          scope: 'issue-refund',
          key: 'idem-1',
          requestFingerprint: fingerprintOf(issuePayload()),
          responseBody: winnerView,
        }),
      );
      const h = await makeHarness(capturedPayment(), new FakePaymentGateway(), store);

      const { view, replayed } = await h.useCase.execute(issuePayload());

      expect(replayed).toBe(true);
      expect(view).toEqual(winnerView);
      expect(h.paymentGateway.refundCount).toBe(0);
      expect(h.store.finalized).toHaveLength(0);
    });
  });
});
