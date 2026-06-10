import { PinoLogger } from 'nestjs-pino';

import { IRetailOrderGetPayload, PaymentStatusEnum } from '@retail-inventory-system/contracts';
import { makePinoLoggerMock } from '@retail-inventory-system/observability/testing';

import { OrderErrorCodeEnum } from '../../../domain';
import { GetOrderUseCase } from '../get-order.use-case';
import {
  buildOrderFixture,
  buildPaymentFixture,
  FakeOrderRepository,
  FakePaymentRepository,
} from './test-doubles';

const OWNER_ID = '00000000-0000-4000-a000-000000000002';
const OTHER_ID = '00000000-0000-4000-a000-000000000099';
const ORDER_ID = 1;

interface IHarness {
  useCase: GetOrderUseCase;
}

const makeHarness = async (): Promise<IHarness> => {
  const logger = makePinoLoggerMock() as unknown as PinoLogger;
  const orderRepository = new FakeOrderRepository();
  const paymentRepository = new FakePaymentRepository();

  // Seed a placed-and-authorized order owned by OWNER_ID, with its payment.
  await orderRepository.save(buildOrderFixture(ORDER_ID, OWNER_ID));
  await paymentRepository.save(buildPaymentFixture(ORDER_ID, ORDER_ID));

  return { useCase: new GetOrderUseCase(orderRepository, paymentRepository, logger) };
};

const getPayload = (overrides: Partial<IRetailOrderGetPayload> = {}): IRetailOrderGetPayload => ({
  orderId: ORDER_ID,
  actorId: OWNER_ID,
  canReadAny: false,
  correlationId: 'corr-1',
  ...overrides,
});

describe('GetOrderUseCase', () => {
  it('lets the owner read its own order (with the payment folded in)', async () => {
    const { useCase } = await makeHarness();

    const view = await useCase.execute(getPayload());

    expect(view.id).toBe(ORDER_ID);
    expect(view.customerId).toBe(OWNER_ID);
    expect(view.lines).toHaveLength(1);
    expect(view.payment).toBeDefined();
    expect(view.payment?.status).toBe(PaymentStatusEnum.AUTHORIZED);
  });

  it('lets staff with order:read (canReadAny) read any order', async () => {
    const { useCase } = await makeHarness();

    const view = await useCase.execute(getPayload({ actorId: OTHER_ID, canReadAny: true }));

    expect(view.id).toBe(ORDER_ID);
    expect(view.customerId).toBe(OWNER_ID);
  });

  it('rejects a non-owner non-staff with ORDER_ACCESS_FORBIDDEN (403)', async () => {
    const { useCase } = await makeHarness();

    await expect(
      useCase.execute(getPayload({ actorId: OTHER_ID, canReadAny: false })),
    ).rejects.toMatchObject({ code: OrderErrorCodeEnum.ORDER_ACCESS_FORBIDDEN });
  });

  it('rejects a missing order with ORDER_NOT_FOUND (404)', async () => {
    const { useCase } = await makeHarness();

    await expect(useCase.execute(getPayload({ orderId: 999 }))).rejects.toMatchObject({
      code: OrderErrorCodeEnum.ORDER_NOT_FOUND,
    });
  });
});
