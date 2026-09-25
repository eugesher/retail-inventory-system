import { PinoLogger } from 'nestjs-pino';

import { bodyFingerprint } from '@retail-inventory-system/common';
import {
  IRetailPaymentCapturePayload,
  OrderPaymentStatusEnum,
  PaymentStatusEnum,
} from '@retail-inventory-system/contracts';
import { makePinoLoggerMock } from '@retail-inventory-system/observability/testing';

import { OrderErrorCodeEnum } from '../../../domain';
import { CapturePaymentUseCase } from '../capture-payment.use-case';
import {
  buildIdempotencyRecord,
  buildOrderFixture,
  buildPaymentFixture,
  FakeIdempotencyStore,
  FakeOrderRepository,
  FakePaymentGateway,
  FakePaymentRepository,
  FakeTransactionPort,
  SpyOrderEventsPublisher,
} from './test-doubles';

const OWNER_ID = '00000000-0000-4000-a000-000000000002';
const OTHER_ID = '00000000-0000-4000-a000-000000000099';
const ORDER_ID = 1;
const GRAND_TOTAL = 1000;

interface IHarness {
  useCase: CapturePaymentUseCase;
  orderRepository: FakeOrderRepository;
  paymentRepository: FakePaymentRepository;
  paymentGateway: FakePaymentGateway;
  publisher: SpyOrderEventsPublisher;
  store: FakeIdempotencyStore;
  seedSaveCount: number;
}

const makeHarness = async (
  ownerId: string = OWNER_ID,
  orderPaymentStatus: OrderPaymentStatusEnum = OrderPaymentStatusEnum.AUTHORIZED,
  paymentStatus: PaymentStatusEnum = PaymentStatusEnum.AUTHORIZED,
  store: FakeIdempotencyStore = new FakeIdempotencyStore(),
  paymentGateway: FakePaymentGateway = new FakePaymentGateway(),
): Promise<IHarness> => {
  const logger = makePinoLoggerMock() as unknown as PinoLogger;
  const orderRepository = new FakeOrderRepository();
  const paymentRepository = new FakePaymentRepository();
  const transactionPort = new FakeTransactionPort();
  const publisher = new SpyOrderEventsPublisher();

  await orderRepository.save(buildOrderFixture(ORDER_ID, ownerId, orderPaymentStatus, GRAND_TOTAL));
  await paymentRepository.save(buildPaymentFixture(ORDER_ID, ORDER_ID, paymentStatus, GRAND_TOTAL));

  const useCase = new CapturePaymentUseCase(
    transactionPort,
    paymentGateway,
    paymentRepository,
    orderRepository,
    publisher,
    store,
    5,
    logger,
  );

  return {
    useCase,
    orderRepository,
    paymentRepository,
    paymentGateway,
    publisher,
    store,
    seedSaveCount: paymentRepository.saveCount,
  };
};

const capturePayload = (
  overrides: Partial<IRetailPaymentCapturePayload> = {},
): IRetailPaymentCapturePayload => ({
  orderId: ORDER_ID,
  actorId: OWNER_ID,
  isStaffCapture: false,
  idempotencyKey: 'idem-1',
  correlationId: 'corr-1',
  ...overrides,
});

const fingerprintOf = (payload: IRetailPaymentCapturePayload): string =>
  bodyFingerprint({ orderId: payload.orderId, amountMinor: payload.amountMinor });

describe('CapturePaymentUseCase', () => {
  it('captures the owner’s authorized payment and emits retail.payment.captured', async () => {
    const h = await makeHarness();

    const { view } = await h.useCase.execute(capturePayload());

    expect(view.paymentStatus).toBe(OrderPaymentStatusEnum.CAPTURED);
    expect(view.payment?.status).toBe(PaymentStatusEnum.CAPTURED);
    expect(view.payment?.capturedAt).toEqual(expect.any(String));
    expect(h.paymentGateway.captureCount).toBe(1);

    expect(h.publisher.captured).toHaveLength(1);
    expect(h.publisher.captured[0]).toMatchObject({
      orderId: ORDER_ID,
      amountMinor: GRAND_TOTAL,
      eventVersion: 'v1',
    });
  });

  it('defaults the captured amount to the order grand total when none is supplied', async () => {
    const h = await makeHarness();

    const { view } = await h.useCase.execute(capturePayload({ amountMinor: undefined }));

    expect(view.payment?.amountMinor).toBe(GRAND_TOTAL);
    expect(h.publisher.captured[0]).toMatchObject({ amountMinor: GRAND_TOTAL });
  });

  it('lets staff (isStaffCapture) capture a non-owner’s order', async () => {
    const h = await makeHarness();

    const { view } = await h.useCase.execute(
      capturePayload({ actorId: OTHER_ID, isStaffCapture: true }),
    );

    expect(view.paymentStatus).toBe(OrderPaymentStatusEnum.CAPTURED);
    expect(h.paymentGateway.captureCount).toBe(1);
  });

  it('rejects a non-owner non-staff with ORDER_ACCESS_FORBIDDEN (403)', async () => {
    const h = await makeHarness();

    await expect(
      h.useCase.execute(capturePayload({ actorId: OTHER_ID, isStaffCapture: false })),
    ).rejects.toMatchObject({ code: OrderErrorCodeEnum.ORDER_ACCESS_FORBIDDEN });
    expect(h.paymentGateway.captureCount).toBe(0);
  });

  it('is idempotent: re-capturing an already-captured payment returns current state', async () => {
    const h = await makeHarness(
      OWNER_ID,
      OrderPaymentStatusEnum.CAPTURED,
      PaymentStatusEnum.CAPTURED,
    );

    const { view } = await h.useCase.execute(capturePayload());

    expect(view.paymentStatus).toBe(OrderPaymentStatusEnum.CAPTURED);
    expect(view.payment?.status).toBe(PaymentStatusEnum.CAPTURED);
    expect(h.paymentGateway.captureCount).toBe(0);
    expect(h.paymentRepository.saveCount).toBe(h.seedSaveCount);
    expect(h.publisher.captured).toHaveLength(0);
  });

  it('releases the claim when the gateway declines the capture — no stranded CAPTURING row', async () => {
    const declining = new FakePaymentGateway(true, false);
    const h = await makeHarness(
      OWNER_ID,
      OrderPaymentStatusEnum.AUTHORIZED,
      PaymentStatusEnum.AUTHORIZED,
      new FakeIdempotencyStore(),
      declining,
    );

    await expect(h.useCase.execute(capturePayload())).rejects.toMatchObject({
      code: OrderErrorCodeEnum.ORDER_PAYMENT_NOT_CAPTURED,
    });

    expect(h.paymentGateway.captureCount).toBe(1);

    const payment = await h.paymentRepository.findByOrderId(ORDER_ID);
    expect(payment?.status).toBe(PaymentStatusEnum.AUTHORIZED);

    expect(h.publisher.captured).toHaveLength(0);
    const order = await h.orderRepository.findById(ORDER_ID);
    expect(order?.paymentStatus).toBe(OrderPaymentStatusEnum.AUTHORIZED);
  });

  it('returns the winner’s state, uncharged, when the lock read finds the payment already CAPTURED', async () => {
    const h = await makeHarness(
      OWNER_ID,
      OrderPaymentStatusEnum.CAPTURED,
      PaymentStatusEnum.CAPTURED,
    );

    jest
      .spyOn(h.paymentRepository, 'findByOrderId')
      .mockResolvedValueOnce(
        buildPaymentFixture(ORDER_ID, ORDER_ID, PaymentStatusEnum.AUTHORIZED, GRAND_TOTAL),
      );

    const { view } = await h.useCase.execute(capturePayload());

    expect(h.paymentGateway.captureCount).toBe(0);
    expect(view.payment?.status).toBe(PaymentStatusEnum.CAPTURED);
    expect(view.paymentStatus).toBe(OrderPaymentStatusEnum.CAPTURED);
    expect(h.paymentRepository.saveCount).toBe(h.seedSaveCount);
    expect(h.publisher.captured).toHaveLength(0);
  });

  it('rejects an order with no payment at all (ORDER_INVALID_PAYMENT_TRANSITION)', async () => {
    const h = await makeHarness();
    jest.spyOn(h.paymentRepository, 'findByOrderId').mockResolvedValueOnce(null);

    await expect(h.useCase.execute(capturePayload())).rejects.toMatchObject({
      code: OrderErrorCodeEnum.ORDER_INVALID_PAYMENT_TRANSITION,
    });
    expect(h.paymentGateway.captureCount).toBe(0);
  });

  it('rejects capturing a failed payment with PAYMENT_INVALID_STATUS_TRANSITION (409)', async () => {
    const h = await makeHarness(
      OWNER_ID,
      OrderPaymentStatusEnum.AUTHORIZED,
      PaymentStatusEnum.FAILED,
    );

    await expect(h.useCase.execute(capturePayload())).rejects.toMatchObject({
      code: OrderErrorCodeEnum.PAYMENT_INVALID_STATUS_TRANSITION,
    });
    expect(h.paymentGateway.captureCount).toBe(0);
  });

  describe('request-level idempotency (ADR-036)', () => {
    it('replays the stored response on a matching key + fingerprint, with no side effects', async () => {
      const store = new FakeIdempotencyStore();
      const priorView = {
        id: ORDER_ID,
        orderNumber: 'ORD-2026-00000001',
        paymentStatus: 'captured',
      };
      store.seed(
        buildIdempotencyRecord({
          scope: 'capture-payment',
          key: 'idem-1',
          requestFingerprint: fingerprintOf(capturePayload()),
          responseBody: priorView,
        }),
      );
      const h = await makeHarness(
        OWNER_ID,
        OrderPaymentStatusEnum.AUTHORIZED,
        PaymentStatusEnum.AUTHORIZED,
        store,
      );

      const { view, replayed } = await h.useCase.execute(capturePayload());

      expect(replayed).toBe(true);
      expect(view).toEqual(priorView);
      expect(h.paymentGateway.captureCount).toBe(0);
      expect(h.publisher.captured).toHaveLength(0);
      expect(h.paymentRepository.saveCount).toBe(h.seedSaveCount);
      expect(h.store.saved).toHaveLength(0);
    });

    it('rejects a reused key with a different body (different fingerprint) as 422', async () => {
      const store = new FakeIdempotencyStore();
      store.seed(
        buildIdempotencyRecord({
          scope: 'capture-payment',
          key: 'idem-1',
          requestFingerprint: 'a-different-body-fingerprint',
        }),
      );
      const h = await makeHarness(
        OWNER_ID,
        OrderPaymentStatusEnum.AUTHORIZED,
        PaymentStatusEnum.AUTHORIZED,
        store,
      );

      await expect(h.useCase.execute(capturePayload())).rejects.toMatchObject({
        code: OrderErrorCodeEnum.ORDER_IDEMPOTENCY_KEY_REUSED,
      });
      expect(h.paymentGateway.captureCount).toBe(0);
    });

    it('rejects a missing Idempotency-Key with ORDER_IDEMPOTENCY_KEY_REQUIRED (400 backstop)', async () => {
      const h = await makeHarness();

      await expect(
        h.useCase.execute(capturePayload({ idempotencyKey: undefined })),
      ).rejects.toMatchObject({ code: OrderErrorCodeEnum.ORDER_IDEMPOTENCY_KEY_REQUIRED });
      expect(h.paymentGateway.captureCount).toBe(0);
    });

    it('persists the stored response after a fresh capture (miss), returned not replayed', async () => {
      const h = await makeHarness();

      const { view, replayed } = await h.useCase.execute(capturePayload());

      expect(replayed).toBe(false);
      expect(h.paymentGateway.captureCount).toBe(1);
      expect(h.publisher.captured).toHaveLength(1);
      expect(h.store.saved).toHaveLength(1);
      expect(h.store.saved[0]).toMatchObject({
        scope: 'capture-payment',
        key: 'idem-1',
        requestFingerprint: fingerprintOf(capturePayload()),
        responseStatus: 200,
      });
      expect((h.store.saved[0].responseBody as { id?: number }).id).toBe(view.id);
    });

    it('converges on the concurrent winner: a duplicate save falls back to the stored winner as a replay', async () => {
      const store = new FakeIdempotencyStore();
      const winnerView = { id: 4242, orderNumber: 'ORD-2026-00004242', paymentStatus: 'captured' };
      store.armConcurrentWinner(
        buildIdempotencyRecord({
          scope: 'capture-payment',
          key: 'idem-1',
          requestFingerprint: fingerprintOf(capturePayload()),
          responseBody: winnerView,
        }),
      );
      const h = await makeHarness(
        OWNER_ID,
        OrderPaymentStatusEnum.AUTHORIZED,
        PaymentStatusEnum.AUTHORIZED,
        store,
      );

      const { view, replayed } = await h.useCase.execute(capturePayload());

      expect(replayed).toBe(true);
      expect(view).toEqual(winnerView);
      expect(h.store.saved).toHaveLength(1);
    });
  });
});
