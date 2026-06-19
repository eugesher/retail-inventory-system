import { EntityManager, Repository } from 'typeorm';

import { ReturnReasonCategoryEnum, ReturnStatusEnum } from '@retail-inventory-system/contracts';

import { ReturnRequest } from '../../../domain';
import { ReturnRequestEntity } from '../return-request.entity';
import { ReturnLineEntity } from '../return-line.entity';
import { ReturnLineMapper } from '../return-line.mapper';
import { ReturnRequestMapper } from '../return-request.mapper';
import { ReturnRequestTypeormRepository } from '../return-request-typeorm.repository';

const CUSTOMER_ID = '11111111-1111-4111-8111-111111111111';

const buildOpenRequest = (): ReturnRequest =>
  ReturnRequest.open(
    {
      orderId: 1,
      customerId: CUSTOMER_ID,
      reasonCategory: ReturnReasonCategoryEnum.DEFECTIVE,
      notes: 'box crushed',
      lines: [{ orderLineId: 10, quantity: 2 }],
    },
    new Date('2026-06-19T09:00:00Z'),
  );

// A persisted-request entity graph (mysql2 returns non-PK BIGINT scalars as strings —
// the mappers coerce them; `customer_id` is a CHAR(36) string, untouched), used as the
// post-commit re-read. The `rma_number` is the value the repository's finalize-UPDATE
// wrote.
const reloadedEntity = (overrides: Partial<ReturnRequestEntity> = {}): ReturnRequestEntity =>
  ({
    id: 1,
    rmaNumber: 'RMA-2026-00000001',
    orderId: '1',
    customerId: CUSTOMER_ID,
    status: ReturnStatusEnum.REQUESTED,
    reasonCategory: ReturnReasonCategoryEnum.DEFECTIVE,
    notes: 'box crushed',
    requestedAt: new Date('2026-06-19T09:00:00Z'),
    authorizedAt: null,
    closedAt: null,
    version: 0,
    lines: [
      {
        id: 50,
        orderLineId: '10',
        quantity: 2,
        condition: null,
        disposition: null,
        lineRefundAmountMinor: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        deletedAt: null,
      },
    ],
    createdAt: new Date(),
    updatedAt: new Date(),
    deletedAt: null,
    ...overrides,
  }) as unknown as ReturnRequestEntity;

describe('return-request mappers', () => {
  it('ReturnRequestMapper.toDomain coerces the BIGINT ids, keeps the customer UUID, maps lines', () => {
    const request = ReturnRequestMapper.toDomain(reloadedEntity());

    expect(request.id).toBe(1);
    expect(request.rmaNumber).toBe('RMA-2026-00000001');
    expect(request.orderId).toBe(1);
    expect(request.customerId).toBe(CUSTOMER_ID);
    expect(request.lines).toHaveLength(1);
    expect(request.lines[0].id).toBe(50);
    expect(request.lines[0].orderLineId).toBe(10);
    // The parent id is threaded into each child on load.
    expect(request.lines[0].returnRequestId).toBe(1);
  });

  it('ReturnRequestMapper.toEntity omits a null id, never writes the version, carries null rmaNumber on open', () => {
    const partial = ReturnRequestMapper.toEntity(buildOpenRequest());

    expect('id' in partial).toBe(false);
    expect('version' in partial).toBe(false);
    expect(partial.rmaNumber).toBeNull();
    expect(partial.status).toBe(ReturnStatusEnum.REQUESTED);
    expect(partial.customerId).toBe(CUSTOMER_ID);
  });

  it('ReturnLineMapper coerces the BIGINT refund amount on load (preserving null)', () => {
    const [line] = ReturnRequestMapper.toDomain(
      reloadedEntity({
        lines: [
          {
            id: 50,
            orderLineId: '10',
            quantity: 2,
            condition: null,
            disposition: null,
            lineRefundAmountMinor: '1299',
            createdAt: new Date(),
            updatedAt: new Date(),
            deletedAt: null,
          },
        ],
      } as unknown as Partial<ReturnRequestEntity>),
    ).lines;

    expect(line.lineRefundAmountMinor).toBe(1299);
  });

  it('ReturnLineMapper omits a null id and carries the returnRequestId so TypeORM inserts', () => {
    const [line] = buildOpenRequest().lines;
    const entity = ReturnLineMapper.toEntity(line, 1);

    expect(entity.id).toBeUndefined();
    expect((entity.returnRequest as { id: number }).id).toBe(1);
    expect(entity.orderLineId).toBe(10);
    expect(entity.quantity).toBe(2);
  });
});

describe('ReturnRequestTypeormRepository', () => {
  let requestRepo: jest.Mocked<Pick<Repository<ReturnRequestEntity>, 'findOne' | 'find'>> & {
    manager: { transaction: jest.Mock };
  };
  let lineRepo: jest.Mocked<Pick<Repository<ReturnLineEntity>, 'save'>>;
  let repository: ReturnRequestTypeormRepository;

  beforeEach(() => {
    jest.resetAllMocks();
    lineRepo = { save: jest.fn() } as never;
    requestRepo = {
      findOne: jest.fn(),
      find: jest.fn(),
      manager: { transaction: jest.fn() },
    } as never;
    repository = new ReturnRequestTypeormRepository(
      requestRepo as unknown as Repository<ReturnRequestEntity>,
      lineRepo as unknown as Repository<ReturnLineEntity>,
    );
  });

  describe('save (new request)', () => {
    it('inserts the root, finalizes the RMA number from the generated id, persists lines, then re-reads', async () => {
      const request = buildOpenRequest();

      const txnRequestRepo = {
        save: jest.fn().mockResolvedValue({ id: 1 }),
        update: jest.fn().mockResolvedValue(undefined),
      };
      const txnLineRepo = { save: jest.fn().mockResolvedValue([]) };
      const manager = {
        getRepository: jest.fn((entity) =>
          entity === ReturnLineEntity ? txnLineRepo : txnRequestRepo,
        ),
      } as unknown as EntityManager;
      requestRepo.manager.transaction.mockImplementation(
        async (cb: (m: EntityManager) => Promise<unknown>) => cb(manager),
      );
      requestRepo.findOne.mockResolvedValue(reloadedEntity());

      const result = await repository.save(request);

      // The root is inserted, then the RMA number is finalized via a targeted UPDATE
      // keyed on the generated id (the order-number idiom; year from requestedAt).
      expect(txnRequestRepo.save).toHaveBeenCalledTimes(1);
      const [whereArg, setArg] = txnRequestRepo.update.mock.calls[0] as [
        { id: number },
        { rmaNumber: string },
      ];
      expect(whereArg).toEqual({ id: 1 });
      expect(setArg.rmaNumber).toBe('RMA-2026-00000001');
      // The line is inserted owning the generated request id.
      const [lineEntities] = txnLineRepo.save.mock.calls[0] as [
        { returnRequest: { id: number } }[],
      ];
      expect(lineEntities[0].returnRequest.id).toBe(1);
      // The returned aggregate carries the re-read concrete ids + rma + version.
      expect(result.id).toBe(1);
      expect(result.rmaNumber).toBe('RMA-2026-00000001');
      expect(result.lines[0].id).toBe(50);
      expect(result.version).toBe(0);
    });
  });

  describe('save (existing request)', () => {
    it('strips the immutable rma_number, updates the root, and re-persists the lines (inspection advances them)', async () => {
      const request = ReturnRequest.reconstitute({
        id: 1,
        rmaNumber: 'RMA-2026-00000001',
        orderId: 1,
        customerId: CUSTOMER_ID,
        status: ReturnStatusEnum.AUTHORIZED,
        reasonCategory: ReturnReasonCategoryEnum.DEFECTIVE,
        notes: 'box crushed',
        requestedAt: new Date('2026-06-19T09:00:00Z'),
        authorizedAt: new Date('2026-06-19T10:00:00Z'),
        closedAt: null,
        lines: buildOpenRequest().lines.slice(),
        version: 1,
      });

      const txnRequestRepo = {
        save: jest.fn().mockResolvedValue({ id: 1 }),
        update: jest.fn(),
      };
      const txnLineRepo = { save: jest.fn().mockResolvedValue([]) };
      const manager = {
        getRepository: jest.fn((entity) =>
          entity === ReturnLineEntity ? txnLineRepo : txnRequestRepo,
        ),
      } as unknown as EntityManager;
      requestRepo.manager.transaction.mockImplementation(
        async (cb: (m: EntityManager) => Promise<unknown>) => cb(manager),
      );
      requestRepo.findOne.mockResolvedValue(
        reloadedEntity({ status: ReturnStatusEnum.AUTHORIZED, version: 1 }),
      );

      const result = await repository.save(request);

      // The root save carries the concrete id but NOT the immutable rma_number.
      const [savedPartial] = txnRequestRepo.save.mock.calls[0] as [
        { id: number; rmaNumber?: string },
      ];
      expect(savedPartial.id).toBe(1);
      expect('rmaNumber' in savedPartial).toBe(false);
      // No re-finalize UPDATE on an existing row; the lines ARE re-persisted.
      expect(txnRequestRepo.update).not.toHaveBeenCalled();
      expect(txnLineRepo.save).toHaveBeenCalledTimes(1);
      expect(result.status).toBe(ReturnStatusEnum.AUTHORIZED);
    });
  });

  describe('findById', () => {
    it('loads a request with its lines', async () => {
      requestRepo.findOne.mockResolvedValue(reloadedEntity());

      const result = await repository.findById(1);

      expect(result?.id).toBe(1);
      expect(result?.lines).toHaveLength(1);
      expect(requestRepo.findOne).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: 1 }, relations: { lines: true } }),
      );
    });

    it('returns null when no row matches', async () => {
      requestRepo.findOne.mockResolvedValue(null);
      await expect(repository.findById(404)).resolves.toBeNull();
    });
  });

  describe('listByOrderId', () => {
    it('lists the order return requests newest-first by requested_at then id', async () => {
      requestRepo.find.mockResolvedValue([reloadedEntity()]);

      const result = await repository.listByOrderId(1);

      expect(result).toHaveLength(1);
      expect(result[0].id).toBe(1);
      expect(requestRepo.find).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { orderId: 1 },
          order: { requestedAt: 'DESC', id: 'DESC', lines: { id: 'ASC' } },
        }),
      );
    });

    it('returns an empty array when an order has no return requests', async () => {
      requestRepo.find.mockResolvedValue([]);
      await expect(repository.listByOrderId(404)).resolves.toEqual([]);
    });
  });
});
