import { PinoLogger } from 'nestjs-pino';

import {
  IRetailPaymentCapturePayload,
  OrderPaymentStatusEnum,
  PaymentStatusEnum,
} from '@retail-inventory-system/contracts';
import { makePinoLoggerMock } from '@retail-inventory-system/observability/testing';

import { OrderErrorCodeEnum } from '../../../domain';
import { CapturePaymentUseCase } from '../capture-payment.use-case';
import {
  buildOrderFixture,
  buildPaymentFixture,
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
  seedSaveCount: number;
}

// Seeds a placed order (at `orderPaymentStatus`) + its single payment (at
// `paymentStatus`), wires the use case against the in-memory fakes.
const makeHarness = async (
  ownerId: string = OWNER_ID,
  orderPaymentStatus: OrderPaymentStatusEnum = OrderPaymentStatusEnum.AUTHORIZED,
  paymentStatus: PaymentStatusEnum = PaymentStatusEnum.AUTHORIZED,
): Promise<IHarness> => {
  const logger = makePinoLoggerMock() as unknown as PinoLogger;
  const orderRepository = new FakeOrderRepository();
  const paymentRepository = new FakePaymentRepository();
  const paymentGateway = new FakePaymentGateway();
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
    logger,
  );

  return {
    useCase,
    orderRepository,
    paymentRepository,
    paymentGateway,
    publisher,
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

describe('CapturePaymentUseCase', () => {
  it('captures the owner’s authorized payment and emits retail.payment.captured', async () => {
    const h = await makeHarness();

    const view = await h.useCase.execute(capturePayload());

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

    const view = await h.useCase.execute(capturePayload({ amountMinor: undefined }));

    expect(view.payment?.amountMinor).toBe(GRAND_TOTAL);
    expect(h.publisher.captured[0]).toMatchObject({ amountMinor: GRAND_TOTAL });
  });

  it('lets staff (isStaffCapture) capture a non-owner’s order', async () => {
    const h = await makeHarness();

    const view = await h.useCase.execute(
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

    const view = await h.useCase.execute(capturePayload());

    expect(view.paymentStatus).toBe(OrderPaymentStatusEnum.CAPTURED);
    expect(view.payment?.status).toBe(PaymentStatusEnum.CAPTURED);
    // No second gateway call, no new payment write, no event.
    expect(h.paymentGateway.captureCount).toBe(0);
    expect(h.paymentRepository.saveCount).toBe(h.seedSaveCount);
    expect(h.publisher.captured).toHaveLength(0);
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
});
