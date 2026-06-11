import { PinoLogger } from 'nestjs-pino';
import { EntityManager, Repository } from 'typeorm';

import { OrderPaymentStatusEnum, OrderStatusEnum } from '@retail-inventory-system/contracts';
import { makePinoLoggerMock, PinoLoggerMock } from '@retail-inventory-system/observability/testing';

import { Order, OrderLine } from '../../../domain';
import { OrderEntity } from '../order.entity';
import { OrderLineEntity } from '../order-line.entity';
import { OrderLineMapper } from '../order-line.mapper';
import { OrderMapper } from '../order.mapper';
import { OrderTypeormRepository } from '../order-typeorm.repository';

const makeLine = (id: number | null, variantId = 7): OrderLine =>
  new OrderLine({
    id,
    variantId,
    sku: `SKU-${variantId}`,
    nameSnapshot: `Variant ${variantId}`,
    quantity: 2,
    unitPriceMinor: 1500,
  });

const buildPlacedOrder = (): Order =>
  Order.place({
    orderNumber: 'ORD-2026-PROVISIONAL',
    customerId: 'cust-1',
    currency: 'USD',
    lines: [makeLine(null, 7)],
    billingAddressId: 'addr-bill',
    shippingAddressId: 'addr-ship',
    sourceCartId: 'cart-1',
    placedAt: new Date('2026-06-10T00:00:00Z'),
  });

// A persisted-order entity graph (mysql2 returns BIGINT scalars as strings — the
// mappers coerce them), used as the post-commit re-read.
const reloadedOrderEntity = (overrides: Partial<OrderEntity> = {}): OrderEntity =>
  ({
    id: 1,
    orderNumber: 'ORD-2026-00000001',
    customerId: 'cust-1',
    currency: 'USD',
    status: OrderStatusEnum.PENDING,
    paymentStatus: OrderPaymentStatusEnum.NONE,
    fulfillmentStatus: 'unfulfilled',
    subtotalMinor: '3000',
    taxTotalMinor: '0',
    discountTotalMinor: '0',
    shippingTotalMinor: '0',
    grandTotalMinor: '3000',
    billingAddressId: 'addr-bill',
    shippingAddressId: 'addr-ship',
    sourceCartId: 'cart-1',
    placedAt: new Date('2026-06-10T00:00:00Z'),
    version: 0,
    lines: [
      {
        id: 10,
        variantId: '7',
        sku: 'SKU-7',
        nameSnapshot: 'Variant 7',
        quantity: 2,
        unitPriceMinor: '1500',
        taxAmountMinor: '0',
        discountAmountMinor: '0',
        lineTotalMinor: '3000',
        status: 'allocated',
        createdAt: new Date(),
        updatedAt: new Date(),
        deletedAt: null,
      },
    ],
    createdAt: new Date(),
    updatedAt: new Date(),
    deletedAt: null,
    ...overrides,
  }) as unknown as OrderEntity;

describe('order mappers', () => {
  it('OrderLineMapper round-trips a line through domain → entity → domain and coerces BIGINTs', () => {
    const line = makeLine(10, 7);

    const entity = {
      ...OrderLineMapper.toEntity(line, 1),
      id: 10,
      variantId: '7' as unknown as number,
      unitPriceMinor: '1500' as unknown as number,
      taxAmountMinor: '0' as unknown as number,
      discountAmountMinor: '0' as unknown as number,
      lineTotalMinor: '3000' as unknown as number,
    } as OrderLineEntity;

    const back = OrderLineMapper.toDomain(entity);

    expect(back.id).toBe(10);
    expect(back.variantId).toBe(7);
    expect(back.unitPriceMinor).toBe(1500);
    expect(back.lineTotalMinor).toBe(3000);
  });

  it('OrderLineMapper omits a null id and carries the orderId so TypeORM inserts', () => {
    const entity = OrderLineMapper.toEntity(makeLine(null, 9), 1);

    expect(entity.id).toBeUndefined();
    expect((entity.order as { id: number }).id).toBe(1);
    expect(entity.variantId).toBe(9);
  });

  it('OrderMapper omits a null id and never writes the version', () => {
    const partial = OrderMapper.toEntity(buildPlacedOrder());

    expect('id' in partial).toBe(false);
    expect('version' in partial).toBe(false);
    expect(partial.status).toBe(OrderStatusEnum.PENDING);
  });

  it('OrderMapper.toDomain coerces the BIGINT money/version strings to numbers', () => {
    const order = OrderMapper.toDomain(reloadedOrderEntity());

    expect(order.id).toBe(1);
    expect(order.subtotalMinor).toBe(3000);
    expect(order.grandTotalMinor).toBe(3000);
    expect(order.lines[0].lineTotalMinor).toBe(3000);
  });
});

describe('OrderTypeormRepository', () => {
  let orderRepo: jest.Mocked<Pick<Repository<OrderEntity>, 'findOne' | 'findAndCount'>> & {
    manager: { transaction: jest.Mock };
  };
  let lineRepo: jest.Mocked<Pick<Repository<OrderLineEntity>, 'save'>>;
  let logger: PinoLoggerMock;
  let repository: OrderTypeormRepository;

  beforeEach(() => {
    jest.resetAllMocks();
    lineRepo = { save: jest.fn() } as never;
    orderRepo = {
      findOne: jest.fn(),
      findAndCount: jest.fn(),
      manager: { transaction: jest.fn() },
    } as never;
    logger = makePinoLoggerMock();
    repository = new OrderTypeormRepository(
      orderRepo as unknown as Repository<OrderEntity>,
      lineRepo as unknown as Repository<OrderLineEntity>,
      logger as unknown as PinoLogger,
    );
  });

  describe('save (new order)', () => {
    it('inserts a provisional number, derives ORD-<year>-00000001 from the id, then re-reads', async () => {
      const order = buildPlacedOrder();

      const txnOrderRepo = {
        save: jest.fn().mockResolvedValue({ id: 1 }),
        update: jest.fn().mockResolvedValue({ affected: 1 }),
      };
      const txnLineRepo = { save: jest.fn().mockResolvedValue([]) };
      const manager = {
        getRepository: jest.fn((entity) =>
          entity === OrderLineEntity ? txnLineRepo : txnOrderRepo,
        ),
      } as unknown as EntityManager;
      orderRepo.manager.transaction.mockImplementation(
        async (cb: (m: EntityManager) => Promise<unknown>) => cb(manager),
      );
      orderRepo.findOne.mockResolvedValue(reloadedOrderEntity());

      const result = await repository.save(order);

      // First insert carries a unique provisional token, never the binding number.
      const [insertedPartial] = txnOrderRepo.save.mock.calls[0] as [{ orderNumber: string }];
      expect(insertedPartial.orderNumber).toMatch(/^TMP-[0-9a-f]{16}$/);
      // The binding number is derived from the generated id (year from placedAt).
      expect(txnOrderRepo.update).toHaveBeenCalledWith(
        { id: 1 },
        { orderNumber: 'ORD-2026-00000001' },
      );
      expect(txnLineRepo.save).toHaveBeenCalledTimes(1);
      // The returned aggregate carries the re-read concrete ids + finalized number.
      expect(result.id).toBe(1);
      expect(result.orderNumber).toBe('ORD-2026-00000001');
      expect(result.lines[0].id).toBe(10);
    });
  });

  describe('save (existing order)', () => {
    it('updates the root without overwriting the immutable order_number', async () => {
      const order = Order.reconstitute({
        id: 1,
        orderNumber: 'ORD-2026-00000001',
        customerId: 'cust-1',
        currency: 'USD',
        status: OrderStatusEnum.PENDING,
        paymentStatus: OrderPaymentStatusEnum.AUTHORIZED,
        fulfillmentStatus: 'unfulfilled' as never,
        lines: [makeLine(10, 7)],
        subtotalMinor: 3000,
        grandTotalMinor: 3000,
        billingAddressId: null,
        shippingAddressId: null,
        sourceCartId: null,
        placedAt: new Date('2026-06-10T00:00:00Z'),
        version: 1,
      });

      const txnOrderRepo = { save: jest.fn().mockResolvedValue({ id: 1 }), update: jest.fn() };
      const txnLineRepo = { save: jest.fn().mockResolvedValue([]) };
      const manager = {
        getRepository: jest.fn((entity) =>
          entity === OrderLineEntity ? txnLineRepo : txnOrderRepo,
        ),
      } as unknown as EntityManager;
      orderRepo.manager.transaction.mockImplementation(
        async (cb: (m: EntityManager) => Promise<unknown>) => cb(manager),
      );
      orderRepo.findOne.mockResolvedValue(
        reloadedOrderEntity({ paymentStatus: OrderPaymentStatusEnum.AUTHORIZED, version: 2 }),
      );

      const result = await repository.save(order);

      // The root partial passed to save carries no order_number (immutable).
      const [savedPartial] = txnOrderRepo.save.mock.calls[0] as [{ orderNumber?: string }];
      expect(savedPartial.orderNumber).toBeUndefined();
      expect(txnOrderRepo.update).not.toHaveBeenCalled();
      expect(result.paymentStatus).toBe(OrderPaymentStatusEnum.AUTHORIZED);
    });
  });

  describe('findBySourceCartId', () => {
    it('resolves the order a converted cart became', async () => {
      orderRepo.findOne.mockResolvedValue(reloadedOrderEntity());

      const result = await repository.findBySourceCartId('cart-1');

      expect(result?.id).toBe(1);
      expect(orderRepo.findOne).toHaveBeenCalledWith(
        expect.objectContaining({ where: { sourceCartId: 'cart-1' } }),
      );
    });

    it('returns null when no order references the cart', async () => {
      orderRepo.findOne.mockResolvedValue(null);
      await expect(repository.findBySourceCartId('cart-x')).resolves.toBeNull();
    });
  });

  describe('listByCustomer', () => {
    it('paginates the customer history newest-first', async () => {
      orderRepo.findAndCount.mockResolvedValue([[reloadedOrderEntity()], 1]);

      const result = await repository.listByCustomer('cust-1', { page: 1, size: 20 });

      expect(result.total).toBe(1);
      expect(result.items).toHaveLength(1);
      expect(orderRepo.findAndCount).toHaveBeenCalledWith(
        expect.objectContaining({ where: { customerId: 'cust-1' }, skip: 0, take: 20 }),
      );
    });
  });
});
