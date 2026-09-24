import { Repository } from 'typeorm';

import { ReturnReasonCategoryEnum, ReturnStatusEnum } from '@retail-inventory-system/contracts';

import { ReturnRequest } from '../../../domain';
import { ReturnRequestEntity } from '../return-request.entity';
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
// re-read result. The `rma_number` is the value the write repository's finalize-UPDATE
// would have written.
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

// The NON-transactional read side only (ADR-063) — `save` and its transactional-manager
// plumbing moved to `ReturnRequestWriteTypeormRepository`, covered by its own spec.
describe('ReturnRequestTypeormRepository', () => {
  let requestRepo: jest.Mocked<Pick<Repository<ReturnRequestEntity>, 'findOne' | 'find'>>;
  let repository: ReturnRequestTypeormRepository;

  beforeEach(() => {
    jest.resetAllMocks();
    requestRepo = { findOne: jest.fn(), find: jest.fn() } as never;
    repository = new ReturnRequestTypeormRepository(
      requestRepo as unknown as Repository<ReturnRequestEntity>,
    );
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
