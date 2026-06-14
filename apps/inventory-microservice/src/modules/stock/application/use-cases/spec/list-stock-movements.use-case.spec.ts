import { PinoLogger } from 'nestjs-pino';

import { StockMovementTypeEnum } from '@retail-inventory-system/contracts';
import { makePinoLoggerMock, PinoLoggerMock } from '@retail-inventory-system/observability/testing';

import { StockMovement } from '../../../domain';
import {
  IStockMovementListQuery,
  IStockMovementPage,
  IStockMovementRepositoryPort,
} from '../../ports';
import { ListStockMovementsUseCase } from '../list-stock-movements.use-case';

const correlationId = 'corr-movements-1';

// A persisted (load-path) movement with sensible defaults; overrides let a test
// pin the field under assertion.
const movement = (props: {
  id: number;
  variantId?: number;
  stockLocationId?: string;
  type?: StockMovementTypeEnum;
  quantity?: number;
  reasonCode?: string | null;
  referenceType?: string | null;
  referenceId?: string | null;
  actorId?: string | null;
  occurredAt?: Date;
}): StockMovement =>
  StockMovement.reconstitute({
    id: props.id,
    variantId: props.variantId ?? 7,
    stockLocationId: props.stockLocationId ?? 'default-warehouse',
    type: props.type ?? StockMovementTypeEnum.ADJUSTMENT,
    // ADJUSTMENT accepts either sign; pick a non-zero default.
    quantity: props.quantity ?? -3,
    reasonCode: props.reasonCode ?? null,
    referenceType: props.referenceType ?? null,
    referenceId: props.referenceId ?? null,
    actorId: props.actorId ?? null,
    occurredAt: props.occurredAt ?? new Date('2026-06-10T12:00:00.000Z'),
  });

describe('ListStockMovementsUseCase', () => {
  // The repository's `listByVariant` is held as a standalone, typed `jest.fn()`
  // (not accessed off the object in assertions) so the `unbound-method` lint rule
  // stays happy and `mock.calls[0][0]` is typed `IStockMovementListQuery` (no
  // unsafe-any). The use case only ever calls this one method.
  let listByVariant: jest.Mock<Promise<IStockMovementPage>, [IStockMovementListQuery]>;
  let repository: IStockMovementRepositoryPort;
  let logger: PinoLoggerMock;
  let useCase: ListStockMovementsUseCase;

  beforeEach(() => {
    listByVariant = jest.fn<Promise<IStockMovementPage>, [IStockMovementListQuery]>();
    repository = { append: jest.fn(), listByVariant } as unknown as IStockMovementRepositoryPort;
    logger = makePinoLoggerMock();
    useCase = new ListStockMovementsUseCase(repository, logger as unknown as PinoLogger);
  });

  it('forwards page/size to the repository query and echoes total + page + size', async () => {
    listByVariant.mockResolvedValue({ items: [], total: 42 });

    const result = await useCase.execute({ variantId: 7, page: 2, size: 5, correlationId });

    // Paging math passes straight through to the repository...
    expect(listByVariant).toHaveBeenCalledWith(
      expect.objectContaining({ variantId: 7, page: 2, size: 5 }),
    );
    // ...and the applied page/size are echoed back alongside the repo's total.
    expect(result.page).toBe(2);
    expect(result.size).toBe(5);
    expect(result.total).toBe(42);
    expect(result.items).toEqual([]);
  });

  it('forwards the type filter and parses from/to ISO bounds into Dates', async () => {
    listByVariant.mockResolvedValue({ items: [], total: 0 });

    await useCase.execute({
      variantId: 7,
      page: 1,
      size: 20,
      type: StockMovementTypeEnum.RECEIPT,
      from: '2026-06-01T00:00:00.000Z',
      to: '2026-06-30T23:59:59.999Z',
      correlationId,
    });

    const query = listByVariant.mock.calls[0][0];
    expect(query.type).toBe(StockMovementTypeEnum.RECEIPT);
    expect(query.from).toEqual(new Date('2026-06-01T00:00:00.000Z'));
    expect(query.to).toEqual(new Date('2026-06-30T23:59:59.999Z'));
  });

  it('treats an unparseable from/to as absent (not a rejection)', async () => {
    listByVariant.mockResolvedValue({ items: [], total: 0 });

    await useCase.execute({
      variantId: 7,
      page: 1,
      size: 20,
      from: 'not-a-date',
      to: '',
      correlationId,
    });

    const query = listByVariant.mock.calls[0][0];
    expect(query.from).toBeUndefined();
    expect(query.to).toBeUndefined();
  });

  it('maps each movement to a StockMovementView (ISO occurredAt, nullable fields preserved)', async () => {
    const occurredAt = new Date('2026-06-10T08:30:00.000Z');
    listByVariant.mockResolvedValue({
      items: [
        // A system adjustment: nullable reference/actor fields stay null.
        movement({
          id: 11,
          type: StockMovementTypeEnum.ADJUSTMENT,
          quantity: -2,
          reasonCode: 'damaged',
          occurredAt,
        }),
        // An order allocation: the polymorphic reference + actor are populated.
        movement({
          id: 10,
          type: StockMovementTypeEnum.ALLOCATION,
          quantity: -4,
          referenceType: 'order',
          referenceId: '500',
          actorId: 'staff-1',
          occurredAt,
        }),
      ],
      total: 2,
    });

    const result = await useCase.execute({ variantId: 7, page: 1, size: 20, correlationId });

    expect(result.items).toHaveLength(2);
    expect(result.items[0]).toEqual({
      id: 11,
      variantId: 7,
      stockLocationId: 'default-warehouse',
      type: StockMovementTypeEnum.ADJUSTMENT,
      quantity: -2,
      reasonCode: 'damaged',
      referenceType: null,
      referenceId: null,
      actorId: null,
      occurredAt: occurredAt.toISOString(),
    });
    expect(result.items[1]).toEqual({
      id: 10,
      variantId: 7,
      stockLocationId: 'default-warehouse',
      type: StockMovementTypeEnum.ALLOCATION,
      quantity: -4,
      reasonCode: null,
      referenceType: 'order',
      referenceId: '500',
      actorId: 'staff-1',
      occurredAt: occurredAt.toISOString(),
    });
    // `occurredAt` is a string on the wire, never a Date.
    expect(typeof result.items[0].occurredAt).toBe('string');
  });

  it('returns an empty page for an unknown variant (no rows, no 404)', async () => {
    listByVariant.mockResolvedValue({ items: [], total: 0 });

    const result = await useCase.execute({ variantId: 9999, page: 1, size: 20, correlationId });

    expect(result).toEqual({ items: [], total: 0, page: 1, size: 20 });
  });
});
