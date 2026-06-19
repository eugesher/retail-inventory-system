import { Repository } from 'typeorm';

import { RefundStatusEnum } from '@retail-inventory-system/contracts';

import { Refund } from '../../../domain';
import { RefundEntity } from '../refund.entity';
import { RefundMapper } from '../refund.mapper';
import { RefundTypeormRepository } from '../refund-typeorm.repository';

// A persisted-refund entity (mysql2 returns BIGINT scalars as strings — the mapper
// coerces them), used as the post-commit re-read.
const refundEntity = (overrides: Partial<RefundEntity> = {}): RefundEntity =>
  ({
    id: 42,
    orderId: '1',
    paymentId: '7',
    amountMinor: '5997',
    currency: 'USD',
    status: RefundStatusEnum.PENDING,
    reason: 'Customer returned the item',
    gatewayReference: null,
    issuedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    deletedAt: null,
    ...overrides,
  }) as unknown as RefundEntity;

describe('RefundMapper', () => {
  it('round-trips a refund and coerces the BIGINT order_id / payment_id / amount_minor strings', () => {
    const refund = RefundMapper.toDomain(refundEntity());

    expect(refund.id).toBe(42);
    expect(refund.orderId).toBe(1);
    expect(refund.paymentId).toBe(7);
    expect(refund.amountMinor).toBe(5997);
    expect(refund.status).toBe(RefundStatusEnum.PENDING);
    // A pending refund carries null gateway_reference / issued_at.
    expect(refund.gatewayReference).toBeNull();
    expect(refund.issuedAt).toBeNull();
  });

  it('preserves a non-null gateway_reference / issued_at on an issued refund', () => {
    const refund = RefundMapper.toDomain(
      refundEntity({
        status: RefundStatusEnum.ISSUED,
        gatewayReference: 'fake_refund_xyz',
        issuedAt: new Date('2026-06-12T10:00:00Z'),
      }),
    );

    expect(refund.status).toBe(RefundStatusEnum.ISSUED);
    expect(refund.gatewayReference).toBe('fake_refund_xyz');
    expect(refund.issuedAt).toEqual(new Date('2026-06-12T10:00:00Z'));
  });

  it('omits a null id so TypeORM inserts a fresh pending refund', () => {
    const partial = RefundMapper.toEntity(
      Refund.open({
        orderId: 1,
        paymentId: 7,
        amountMinor: 5997,
        currency: 'USD',
        reason: 'Customer returned the item',
      }),
    );

    expect('id' in partial).toBe(false);
    expect(partial.status).toBe(RefundStatusEnum.PENDING);
    expect(partial.gatewayReference).toBeNull();
    expect(partial.issuedAt).toBeNull();
  });
});

describe('RefundTypeormRepository', () => {
  let refundRepo: jest.Mocked<Pick<Repository<RefundEntity>, 'save' | 'findOne' | 'find'>>;
  let repository: RefundTypeormRepository;

  beforeEach(() => {
    jest.resetAllMocks();
    refundRepo = { save: jest.fn(), findOne: jest.fn(), find: jest.fn() } as never;
    repository = new RefundTypeormRepository(refundRepo as unknown as Repository<RefundEntity>);
  });

  const newRefund = (): Refund =>
    Refund.open({
      orderId: 1,
      paymentId: 7,
      amountMinor: 5997,
      currency: 'USD',
      reason: 'Customer returned the item',
    });

  describe('save', () => {
    it('upserts then re-reads the committed row, returning the concrete id', async () => {
      refundRepo.save.mockResolvedValue(refundEntity());
      refundRepo.findOne.mockResolvedValue(refundEntity());

      const result = await repository.save(newRefund());

      expect(refundRepo.save).toHaveBeenCalledTimes(1);
      expect(result.id).toBe(42);
      expect(result.orderId).toBe(1);
      expect(result.paymentId).toBe(7);
      expect(result.amountMinor).toBe(5997);
    });

    it('throws when the just-written row cannot be re-read', async () => {
      refundRepo.save.mockResolvedValue(refundEntity());
      refundRepo.findOne.mockResolvedValue(null);

      await expect(repository.save(newRefund())).rejects.toThrow(/vanished after commit/);
    });
  });

  describe('findById', () => {
    it('returns the refund when a row matches', async () => {
      refundRepo.findOne.mockResolvedValue(refundEntity());

      const result = await repository.findById(42);

      expect(result?.id).toBe(42);
    });

    it('returns null when no row matches', async () => {
      refundRepo.findOne.mockResolvedValue(null);
      await expect(repository.findById(404)).resolves.toBeNull();
    });
  });

  describe('findByOrderId', () => {
    it('lists the order refunds newest-first by issued_at then id', async () => {
      refundRepo.find.mockResolvedValue([refundEntity()]);

      const result = await repository.findByOrderId(1);

      expect(result).toHaveLength(1);
      expect(refundRepo.find).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { orderId: 1 },
          order: { issuedAt: 'DESC', id: 'DESC' },
        }),
      );
    });

    it('returns an empty array when the order has no refunds', async () => {
      refundRepo.find.mockResolvedValue([]);
      await expect(repository.findByOrderId(404)).resolves.toEqual([]);
    });
  });

  describe('findByPaymentId', () => {
    it('lists the payment refunds (backs the over-refund guard)', async () => {
      refundRepo.find.mockResolvedValue([refundEntity()]);

      const result = await repository.findByPaymentId(7);

      expect(result).toHaveLength(1);
      expect(refundRepo.find).toHaveBeenCalledWith(
        expect.objectContaining({ where: { paymentId: 7 } }),
      );
    });
  });
});
