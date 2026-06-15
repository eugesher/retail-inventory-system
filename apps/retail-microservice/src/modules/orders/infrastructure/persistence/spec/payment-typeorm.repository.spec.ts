import { Repository } from 'typeorm';

import { PaymentStatusEnum } from '@retail-inventory-system/contracts';

import { Payment } from '../../../domain';
import { PaymentEntity } from '../payment.entity';
import { PaymentMapper } from '../payment.mapper';
import { PaymentTypeormRepository } from '../payment-typeorm.repository';

// A persisted-payment entity (mysql2 returns BIGINT scalars as strings — the mapper
// coerces them), used as the post-commit re-read.
const paymentEntity = (overrides: Partial<PaymentEntity> = {}): PaymentEntity =>
  ({
    id: 9,
    orderId: '1',
    amountMinor: '5997',
    currency: 'USD',
    method: 'fake-card',
    status: PaymentStatusEnum.AUTHORIZED,
    gatewayReference: 'fake_abc123',
    authorizedAt: new Date('2026-06-10T00:00:00Z'),
    capturedAt: null,
    flaggedForRefund: false,
    createdAt: new Date(),
    updatedAt: new Date(),
    deletedAt: null,
    ...overrides,
  }) as unknown as PaymentEntity;

describe('PaymentMapper', () => {
  it('round-trips a payment and coerces the BIGINT order_id / amount_minor strings', () => {
    const payment = PaymentMapper.toDomain(paymentEntity());

    expect(payment.id).toBe(9);
    expect(payment.orderId).toBe(1);
    expect(payment.amountMinor).toBe(5997);
    expect(payment.status).toBe(PaymentStatusEnum.AUTHORIZED);
    expect(payment.flaggedForRefund).toBe(false);
  });

  it('omits a null id so TypeORM inserts a fresh authorize', () => {
    const partial = PaymentMapper.toEntity(
      Payment.authorized({
        orderId: 1,
        amountMinor: 5997,
        currency: 'USD',
        method: 'fake-card',
        gatewayReference: 'fake_abc123',
        authorizedAt: new Date('2026-06-10T00:00:00Z'),
      }),
    );

    expect('id' in partial).toBe(false);
    expect(partial.status).toBe(PaymentStatusEnum.AUTHORIZED);
    expect(partial.capturedAt).toBeNull();
    expect(partial.flaggedForRefund).toBe(false);
  });
});

describe('PaymentTypeormRepository', () => {
  let paymentRepo: jest.Mocked<Pick<Repository<PaymentEntity>, 'save' | 'findOne'>>;
  let repository: PaymentTypeormRepository;

  beforeEach(() => {
    jest.resetAllMocks();
    paymentRepo = { save: jest.fn(), findOne: jest.fn() } as never;
    repository = new PaymentTypeormRepository(paymentRepo as unknown as Repository<PaymentEntity>);
  });

  describe('save', () => {
    it('upserts then re-reads the committed row, returning the concrete id', async () => {
      const payment = Payment.authorized({
        orderId: 1,
        amountMinor: 5997,
        currency: 'USD',
        method: 'fake-card',
        gatewayReference: 'fake_abc123',
        authorizedAt: new Date('2026-06-10T00:00:00Z'),
      });
      paymentRepo.save.mockResolvedValue(paymentEntity());
      paymentRepo.findOne.mockResolvedValue(paymentEntity());

      const result = await repository.save(payment);

      expect(paymentRepo.save).toHaveBeenCalledTimes(1);
      expect(result.id).toBe(9);
      expect(result.orderId).toBe(1);
      expect(result.amountMinor).toBe(5997);
    });
  });

  describe('findByOrderId', () => {
    it('resolves the single payment for an order', async () => {
      paymentRepo.findOne.mockResolvedValue(paymentEntity());

      const result = await repository.findByOrderId(1);

      expect(result?.id).toBe(9);
      expect(paymentRepo.findOne).toHaveBeenCalledWith(
        expect.objectContaining({ where: { orderId: 1 } }),
      );
    });

    it('returns null when no payment references the order', async () => {
      paymentRepo.findOne.mockResolvedValue(null);
      await expect(repository.findByOrderId(404)).resolves.toBeNull();
    });
  });

  describe('findById', () => {
    it('returns null when no row matches', async () => {
      paymentRepo.findOne.mockResolvedValue(null);
      await expect(repository.findById(404)).resolves.toBeNull();
    });
  });
});
