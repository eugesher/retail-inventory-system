import { EntityManager } from 'typeorm';

import { ReturnReasonCategoryEnum, ReturnStatusEnum } from '@retail-inventory-system/contracts';

import { ReturnRequest } from '../../../domain';
import { ReturnLineEntity } from '../return-line.entity';
import { ReturnRequestEntity } from '../return-request.entity';
import { ReturnRequestWriteTypeormRepository } from '../return-request-write-typeorm.repository';

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

// The write-capable half (ADR-063) — bound to a fake transactional `EntityManager`
// directly, the way `ReturnsUnitOfWorkAdapter.build` constructs one per unit of work. The
// `save (new request)` / `save (existing request)` behavior is unchanged from the pre-UoW
// `ReturnRequestTypeormRepository.save`; only the manager it runs against moved from an
// internal `manager.transaction(...)` call to the constructor.
describe('ReturnRequestWriteTypeormRepository', () => {
  describe('save (new request)', () => {
    it('inserts the root, finalizes the RMA number from the generated id, persists lines, then re-reads', async () => {
      const request = buildOpenRequest();

      const txnRequestRepo = {
        save: jest.fn().mockResolvedValue({ id: 1 }),
        update: jest.fn().mockResolvedValue(undefined),
        findOne: jest.fn().mockResolvedValue(reloadedEntity()),
      };
      const txnLineRepo = { save: jest.fn().mockResolvedValue([]) };
      const manager = {
        getRepository: jest.fn((entity) =>
          entity === ReturnLineEntity ? txnLineRepo : txnRequestRepo,
        ),
      } as unknown as EntityManager;
      const defaultManager = {} as unknown as EntityManager;
      const repository = new ReturnRequestWriteTypeormRepository(manager, defaultManager);

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
        findOne: jest
          .fn()
          .mockResolvedValue(reloadedEntity({ status: ReturnStatusEnum.AUTHORIZED, version: 1 })),
      };
      const txnLineRepo = { save: jest.fn().mockResolvedValue([]) };
      const manager = {
        getRepository: jest.fn((entity) =>
          entity === ReturnLineEntity ? txnLineRepo : txnRequestRepo,
        ),
      } as unknown as EntityManager;
      const defaultManager = {} as unknown as EntityManager;
      const repository = new ReturnRequestWriteTypeormRepository(manager, defaultManager);

      const result = await repository.save(request);

      // No `expectedVersion` — the plain managed save, not the version-checked CAS. The
      // root save carries the concrete id but NOT the immutable rma_number.
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
});
