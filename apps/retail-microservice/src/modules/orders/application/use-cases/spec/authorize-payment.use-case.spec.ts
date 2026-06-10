import { PinoLogger } from 'nestjs-pino';

import { OrderPaymentStatusEnum, PaymentStatusEnum } from '@retail-inventory-system/contracts';
import { makePinoLoggerMock, PinoLoggerMock } from '@retail-inventory-system/observability/testing';

import { Order, OrderDomainException, OrderErrorCodeEnum, OrderLine } from '../../../domain';
import { AuthorizePaymentUseCase } from '../authorize-payment.use-case';
import {
  FakeOrderRepository,
  FakePaymentGateway,
  FakePaymentRepository,
  FakeTransactionPort,
} from './test-doubles';

const CUSTOMER_ID = '00000000-0000-4000-a000-000000000002';

// Seeds a placed order (paymentStatus `none`) in the fake repo and returns its id.
const seedOrder = async (orderRepository: FakeOrderRepository): Promise<number> => {
  const line = new OrderLine({
    id: null,
    variantId: 1,
    sku: 'AURORA-WARM',
    nameSnapshot: 'Aurora Desk Lamp',
    quantity: 2,
    unitPriceMinor: 4999,
  });
  const order = Order.place({
    orderNumber: 'PENDING',
    customerId: CUSTOMER_ID,
    currency: 'USD',
    lines: [line],
    billingAddressId: null,
    shippingAddressId: null,
    sourceCartId: 'cart-1',
    placedAt: new Date('2026-06-10T00:00:00.000Z'),
  });
  const saved = await orderRepository.save(order);
  return saved.id!;
};

describe('AuthorizePaymentUseCase', () => {
  let orderRepository: FakeOrderRepository;
  let paymentRepository: FakePaymentRepository;
  let logger: PinoLoggerMock;

  beforeEach(() => {
    orderRepository = new FakeOrderRepository();
    paymentRepository = new FakePaymentRepository();
    logger = makePinoLoggerMock();
  });

  it('persists an authorized Payment and advances the order payment axis to authorized', async () => {
    const orderId = await seedOrder(orderRepository);
    const gateway = new FakePaymentGateway(true);
    const useCase = new AuthorizePaymentUseCase(
      new FakeTransactionPort(),
      gateway,
      paymentRepository,
      orderRepository,
      logger as unknown as PinoLogger,
    );

    const payment = await useCase.execute({
      orderId,
      amountMinor: 9998,
      currency: 'USD',
      method: 'tok_visa',
      correlationId: 'corr-1',
    });

    expect(gateway.authorizeCount).toBe(1);
    expect(payment.id).toEqual(expect.any(Number));
    expect(payment.orderId).toBe(orderId);
    expect(payment.amountMinor).toBe(9998);
    expect(payment.status).toBe(PaymentStatusEnum.AUTHORIZED);
    expect(payment.method).toBe('tok_visa');
    expect(payment.gatewayReference).toMatch(/^fake_/);
    expect(payment.authorizedAt).toBeInstanceOf(Date);
    expect(payment.capturedAt).toBeNull();

    const order = await orderRepository.findById(orderId);
    expect(order?.paymentStatus).toBe(OrderPaymentStatusEnum.AUTHORIZED);
    expect(await paymentRepository.findByOrderId(orderId)).not.toBeNull();
  });

  it('leaves the order unpaid and surfaces a typed rejection on a non-approval', async () => {
    const orderId = await seedOrder(orderRepository);
    const gateway = new FakePaymentGateway(false);
    const useCase = new AuthorizePaymentUseCase(
      new FakeTransactionPort(),
      gateway,
      paymentRepository,
      orderRepository,
      logger as unknown as PinoLogger,
    );

    await expect(
      useCase.execute({ orderId, amountMinor: 9998, currency: 'USD', correlationId: 'corr-2' }),
    ).rejects.toMatchObject({ code: OrderErrorCodeEnum.ORDER_PAYMENT_NOT_APPROVED });

    const order = await orderRepository.findById(orderId);
    expect(order?.paymentStatus).toBe(OrderPaymentStatusEnum.NONE);
    expect(await paymentRepository.findByOrderId(orderId)).toBeNull();
    expect(paymentRepository.saveCount).toBe(0);
  });

  it('throws OrderDomainException (asserted via instanceof) on a non-approval', async () => {
    const orderId = await seedOrder(orderRepository);
    const useCase = new AuthorizePaymentUseCase(
      new FakeTransactionPort(),
      new FakePaymentGateway(false),
      paymentRepository,
      orderRepository,
      logger as unknown as PinoLogger,
    );

    await expect(
      useCase.execute({ orderId, amountMinor: 1, currency: 'USD', correlationId: 'corr-3' }),
    ).rejects.toBeInstanceOf(OrderDomainException);
  });
});
