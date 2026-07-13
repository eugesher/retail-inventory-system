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

// Seeds a placed order (at `orderPaymentStatus`) + its single payment (at
// `paymentStatus`), wires the use case against the in-memory fakes.
//
// `paymentGateway` is a parameter so a test can inject a **declining** double. `FakePaymentGateway`
// has taken a `captureOk` flag since it was written and **no spec ever passed `false`** — which is
// exactly why the decline branch sat at zero coverage, and it is the same shape of miss ISSUE-06
// found one method over on `approve`.
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
    // OCC_RETRY_ATTEMPTS budget (ADR-036).
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

// The canonical body the use case fingerprints — the client-controlled capture command
// (`orderId` + optional `amountMinor`) minus `correlationId` / `idempotencyKey` / the
// owner-injected `actorId` / `isStaffCapture` (ADR-036). Recomputed here so a seeded
// record's fingerprint matches (a replay) or deliberately diverges (a 422).
const fingerprintOf = (payload: IRetailPaymentCapturePayload): string =>
  bodyFingerprint({ orderId: payload.orderId, amountMinor: payload.amountMinor });

describe('CapturePaymentUseCase', () => {
  it('captures the owner’s authorized payment and emits retail.payment.captured', async () => {
    const h = await makeHarness();

    const { view } = await h.useCase.execute(capturePayload());

    // Both axes advance: the order's payment axis and the payment row.
    expect(view.paymentStatus).toBe(OrderPaymentStatusEnum.CAPTURED);
    expect(view.payment?.status).toBe(PaymentStatusEnum.CAPTURED);
    expect(view.payment?.capturedAt).toEqual(expect.any(String));
    expect(h.paymentGateway.captureCount).toBe(1);

    // The captured event fired with the grand total as the captured amount.
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
    // No second gateway call, no new payment write, no event.
    expect(h.paymentGateway.captureCount).toBe(0);
    expect(h.paymentRepository.saveCount).toBe(h.seedSaveCount);
    expect(h.publisher.captured).toHaveLength(0);
  });

  // **The declined capture (ADR-052, phase 2).** The gateway said no, so we KNOW no money moved — the
  // one and only condition under which a claim may be released. `Payment.releaseCapture` says so in as
  // many words ("reachable from exactly one place: the explicit `!result.captured` branch"), and until
  // this test that branch — and therefore that method — was executed by nothing at all.
  //
  // What makes it worth a test rather than a reading: if the release is broken or skipped, the payment
  // stays at `CAPTURING` **forever**. Nothing recovers it, by design — `ReportStaleCaptureClaimsUseCase`
  // only reports a stranded claim, because releasing one it did not personally decline would risk a
  // second charge. So a bug here does not lose a request; it manufactures the exact incident the
  // ADR-053 register exists to chase down, and hands the customer an authorization that can never be
  // captured.
  it('releases the claim when the gateway declines the capture — no stranded CAPTURING row', async () => {
    const declining = new FakePaymentGateway(true, false); // approve authorize, decline capture
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

    // The processor WAS reached — this is a decline, not a pre-flight refusal.
    expect(h.paymentGateway.captureCount).toBe(1);

    // **The claim is gone and the authorization is capturable again.** `AUTHORIZED`, not `CAPTURING`:
    // the difference between "try again" and a payment no code path can ever resolve.
    const payment = await h.paymentRepository.findByOrderId(ORDER_ID);
    expect(payment?.status).toBe(PaymentStatusEnum.AUTHORIZED);

    // Nothing moved, so nothing is announced and the order's payment axis is untouched.
    expect(h.publisher.captured).toHaveLength(0);
    const order = await h.orderRepository.findById(ORDER_ID);
    expect(order?.paymentStatus).toBe(OrderPaymentStatusEnum.AUTHORIZED);
  });

  // **The race the fast path cannot see (ADR-052, `AlreadyCapturedSignal`).**
  //
  // There are two "already captured" paths and only one of them was tested. The *fast* one reads the
  // payment on a snapshot and returns early — that is the sequential retry, and it is covered above.
  // This is the other one: the snapshot said `AUTHORIZED`, and by the time the `SELECT … FOR UPDATE`
  // was granted, the winner had **completed**. A `FOR UPDATE` read is a CURRENT read, so the lock sees
  // `CAPTURED` where the snapshot saw `AUTHORIZED` — and the loser must return the winner's state
  // rather than charge a second time.
  //
  // The setup models that faithfully with **exactly one stub**: the store genuinely holds the winner's
  // committed `CAPTURED` state (that is what "the winner committed" means), and only the fast path's
  // *snapshot* read is made stale. Every other read — the locked one, and the re-read after the signal —
  // runs for real and sees current state, which is precisely the asymmetry `FOR UPDATE` buys.
  //
  // (The mutual exclusion itself is not provable against an in-memory double and is not attempted here;
  // it is proved against MySQL in `test/concurrent-capture-double-charge.e2e-spec.ts`, which counts
  // gateway calls.)
  it('returns the winner’s state, uncharged, when the lock read finds the payment already CAPTURED', async () => {
    // The winner has already completed: both axes committed as CAPTURED.
    const h = await makeHarness(
      OWNER_ID,
      OrderPaymentStatusEnum.CAPTURED,
      PaymentStatusEnum.CAPTURED,
    );

    // ...but THIS caller's snapshot read predates that commit, so it still sees AUTHORIZED and does not
    // take the fast-path early return. One stub, one lie, and it is the lie a stale snapshot actually
    // tells.
    jest
      .spyOn(h.paymentRepository, 'findByOrderId')
      .mockResolvedValueOnce(
        buildPaymentFixture(ORDER_ID, ORDER_ID, PaymentStatusEnum.AUTHORIZED, GRAND_TOTAL),
      );

    const { view } = await h.useCase.execute(capturePayload());

    // **Nothing was charged.** This is the whole assertion: the loser reached the lock, saw the winner,
    // and stopped short of the processor.
    expect(h.paymentGateway.captureCount).toBe(0);
    expect(view.payment?.status).toBe(PaymentStatusEnum.CAPTURED);
    expect(view.paymentStatus).toBe(OrderPaymentStatusEnum.CAPTURED);
    // No second transition, and no second `retail.payment.captured` — the winner already emitted it.
    expect(h.paymentRepository.saveCount).toBe(h.seedSaveCount);
    expect(h.publisher.captured).toHaveLength(0);
  });

  // The `!payment` guard. A placed order is authorized-on-place, so a payment-less order means the
  // authorize never produced one — there is nothing to capture, and it must not reach the gateway.
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
      // A prior capture under the same key + canonical body — its stored OrderView is what
      // the replay must return verbatim.
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
      // A replay is side-effect-free: no gateway call, no payment write, no event, no
      // second store write.
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
      // Rejected before any capture work runs.
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
      // The capture ran (a fresh execution): one gateway call, one captured event.
      expect(h.paymentGateway.captureCount).toBe(1);
      expect(h.publisher.captured).toHaveLength(1);
      // The record was stored under (capture-payment, key) with the fingerprint + the
      // OrderView body + the 200 success status.
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
      // A simultaneous identical capture committed + stored first (a DISTINCT stored body). It
      // is hidden from our first lookup (the miss) and revealed on the post-save re-read.
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

      // Our save lost the composite-PK race, so the winner's stored response is returned as
      // a replay — the two racers converge on one response.
      expect(replayed).toBe(true);
      expect(view).toEqual(winnerView);
      expect(h.store.saved).toHaveLength(1);
    });
  });
});
