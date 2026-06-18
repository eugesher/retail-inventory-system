import { EntityManager, Repository } from 'typeorm';

import { FulfillmentStatusEnum } from '@retail-inventory-system/contracts';

import { Fulfillment } from '../../../domain';
import { FulfillmentEntity } from '../fulfillment.entity';
import { FulfillmentLineEntity } from '../fulfillment-line.entity';
import { FulfillmentLineMapper } from '../fulfillment-line.mapper';
import { FulfillmentMapper } from '../fulfillment.mapper';
import { FulfillmentTypeormRepository } from '../fulfillment-typeorm.repository';

const buildPendingFulfillment = (): Fulfillment =>
  Fulfillment.create({
    orderId: 1,
    stockLocationId: 'default-warehouse',
    lines: [{ orderLineId: 10, quantity: 2 }],
  });

// A persisted-fulfillment entity graph (mysql2 returns non-PK BIGINT scalars as
// strings — the mappers coerce them), used as the post-commit re-read.
const reloadedEntity = (overrides: Partial<FulfillmentEntity> = {}): FulfillmentEntity =>
  ({
    id: 5,
    orderId: '1',
    stockLocationId: 'default-warehouse',
    status: FulfillmentStatusEnum.PENDING,
    trackingNumber: null,
    carrier: null,
    shippedAt: null,
    deliveredAt: null,
    version: 0,
    lines: [
      {
        id: 50,
        orderLineId: '10',
        quantity: 2,
        createdAt: new Date(),
        updatedAt: new Date(),
        deletedAt: null,
      },
    ],
    createdAt: new Date(),
    updatedAt: new Date(),
    deletedAt: null,
    ...overrides,
  }) as unknown as FulfillmentEntity;

describe('fulfillment mappers', () => {
  it('FulfillmentMapper.toDomain coerces the BIGINT order_id / line ids and maps the lines', () => {
    const fulfillment = FulfillmentMapper.toDomain(reloadedEntity());

    expect(fulfillment.id).toBe(5);
    expect(fulfillment.orderId).toBe(1);
    expect(fulfillment.lines).toHaveLength(1);
    expect(fulfillment.lines[0].id).toBe(50);
    expect(fulfillment.lines[0].orderLineId).toBe(10);
    // The parent id is threaded into each child on load.
    expect(fulfillment.lines[0].fulfillmentId).toBe(5);
  });

  it('FulfillmentMapper.toEntity omits a null id and never writes the version', () => {
    const partial = FulfillmentMapper.toEntity(buildPendingFulfillment());

    expect('id' in partial).toBe(false);
    expect('version' in partial).toBe(false);
    expect(partial.status).toBe(FulfillmentStatusEnum.PENDING);
    expect(partial.stockLocationId).toBe('default-warehouse');
  });

  it('FulfillmentLineMapper omits a null id and carries the fulfillmentId so TypeORM inserts', () => {
    const [line] = buildPendingFulfillment().lines;
    const entity = FulfillmentLineMapper.toEntity(line, 5);

    expect(entity.id).toBeUndefined();
    expect((entity.fulfillment as { id: number }).id).toBe(5);
    expect(entity.orderLineId).toBe(10);
    expect(entity.quantity).toBe(2);
  });
});

describe('FulfillmentTypeormRepository', () => {
  let fulfillmentRepo: jest.Mocked<Pick<Repository<FulfillmentEntity>, 'findOne' | 'find'>> & {
    manager: { transaction: jest.Mock };
  };
  let lineRepo: jest.Mocked<Pick<Repository<FulfillmentLineEntity>, 'save'>>;
  let repository: FulfillmentTypeormRepository;

  beforeEach(() => {
    jest.resetAllMocks();
    lineRepo = { save: jest.fn() } as never;
    fulfillmentRepo = {
      findOne: jest.fn(),
      find: jest.fn(),
      manager: { transaction: jest.fn() },
    } as never;
    repository = new FulfillmentTypeormRepository(
      fulfillmentRepo as unknown as Repository<FulfillmentEntity>,
      lineRepo as unknown as Repository<FulfillmentLineEntity>,
    );
  });

  describe('save (new fulfillment)', () => {
    it('inserts the root, persists the lines owning the generated id, then re-reads', async () => {
      const fulfillment = buildPendingFulfillment();

      const txnFulfillmentRepo = { save: jest.fn().mockResolvedValue({ id: 5 }) };
      const txnLineRepo = { save: jest.fn().mockResolvedValue([]) };
      const manager = {
        getRepository: jest.fn((entity) =>
          entity === FulfillmentLineEntity ? txnLineRepo : txnFulfillmentRepo,
        ),
      } as unknown as EntityManager;
      fulfillmentRepo.manager.transaction.mockImplementation(
        async (cb: (m: EntityManager) => Promise<unknown>) => cb(manager),
      );
      fulfillmentRepo.findOne.mockResolvedValue(reloadedEntity());

      const result = await repository.save(fulfillment);

      expect(txnFulfillmentRepo.save).toHaveBeenCalledTimes(1);
      // The line is inserted owning the generated fulfillment id.
      const [lineEntities] = txnLineRepo.save.mock.calls[0] as [{ fulfillment: { id: number } }[]];
      expect(lineEntities[0].fulfillment.id).toBe(5);
      // The returned aggregate carries the re-read concrete ids + version.
      expect(result.id).toBe(5);
      expect(result.lines[0].id).toBe(50);
      expect(result.version).toBe(0);
    });
  });

  describe('save (existing fulfillment)', () => {
    it('updates the root only — the immutable lines are never rewritten', async () => {
      const fulfillment = Fulfillment.reconstitute({
        id: 5,
        orderId: 1,
        stockLocationId: 'default-warehouse',
        status: FulfillmentStatusEnum.SHIPPED,
        trackingNumber: 'TRACK-1',
        carrier: 'ups',
        shippedAt: new Date('2026-06-15T10:00:00Z'),
        deliveredAt: null,
        lines: buildPendingFulfillment().lines.slice(),
        version: 1,
      });

      const txnFulfillmentRepo = { save: jest.fn().mockResolvedValue({ id: 5 }) };
      const txnLineRepo = { save: jest.fn() };
      const manager = {
        getRepository: jest.fn((entity) =>
          entity === FulfillmentLineEntity ? txnLineRepo : txnFulfillmentRepo,
        ),
      } as unknown as EntityManager;
      fulfillmentRepo.manager.transaction.mockImplementation(
        async (cb: (m: EntityManager) => Promise<unknown>) => cb(manager),
      );
      fulfillmentRepo.findOne.mockResolvedValue(
        reloadedEntity({
          status: FulfillmentStatusEnum.SHIPPED,
          trackingNumber: 'TRACK-1',
          carrier: 'ups',
          version: 1,
        }),
      );

      const result = await repository.save(fulfillment);

      // The root save carries the concrete id; the lines are untouched on a re-save.
      const [savedPartial] = txnFulfillmentRepo.save.mock.calls[0] as [{ id: number }];
      expect(savedPartial.id).toBe(5);
      expect(txnLineRepo.save).not.toHaveBeenCalled();
      expect(result.status).toBe(FulfillmentStatusEnum.SHIPPED);
      expect(result.trackingNumber).toBe('TRACK-1');
    });
  });

  describe('findById', () => {
    it('loads a fulfillment with its lines', async () => {
      fulfillmentRepo.findOne.mockResolvedValue(reloadedEntity());

      const result = await repository.findById(5);

      expect(result?.id).toBe(5);
      expect(result?.lines).toHaveLength(1);
      expect(fulfillmentRepo.findOne).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: 5 }, relations: { lines: true } }),
      );
    });

    it('returns null when no row matches', async () => {
      fulfillmentRepo.findOne.mockResolvedValue(null);
      await expect(repository.findById(404)).resolves.toBeNull();
    });
  });

  describe('listByOrderId', () => {
    it('lists the order fulfillments newest-first by shipped_at then id', async () => {
      fulfillmentRepo.find.mockResolvedValue([reloadedEntity()]);

      const result = await repository.listByOrderId(1);

      expect(result).toHaveLength(1);
      expect(result[0].id).toBe(5);
      expect(fulfillmentRepo.find).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { orderId: 1 },
          order: { shippedAt: 'DESC', id: 'DESC', lines: { id: 'ASC' } },
        }),
      );
    });

    it('returns an empty array when an order has no fulfillments', async () => {
      fulfillmentRepo.find.mockResolvedValue([]);
      await expect(repository.listByOrderId(404)).resolves.toEqual([]);
    });
  });
});
