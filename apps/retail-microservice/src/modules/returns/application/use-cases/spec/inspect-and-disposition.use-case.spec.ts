import { PinoLogger } from 'nestjs-pino';

import {
  IRetailReturnInspectPayload,
  ReturnDispositionEnum,
  ReturnLineConditionEnum,
  ReturnReasonCategoryEnum,
  ReturnStatusEnum,
} from '@retail-inventory-system/contracts';
import { makePinoLoggerMock } from '@retail-inventory-system/observability/testing';

import { ReturnErrorCodeEnum, ReturnLine, ReturnRequest } from '../../../domain';
import { IReturnOrderSnapshot } from '../../ports';
import { InspectAndDispositionUseCase } from '../inspect-and-disposition.use-case';
import {
  FakeInventoryRestockGateway,
  FakeReturnOrderReader,
  FakeReturnRequestRepository,
  FakeTransactionPort,
  SpyReturnEventsPublisher,
} from './test-doubles';

const WAREHOUSE_ID = '88888888-8888-4888-8888-888888888888';
const RETURN_OWNER_ID = '11111111-1111-4111-8111-111111111111';

// A two-line RMA at a given status (id 7; line 71 → orderLine 10 qty 2, line 72 → orderLine
// 20 qty 1) — the fixture the inspect specs seed. Concrete line ids so the inspect payload
// can address them.
const buildReturnAt = (status: ReturnStatusEnum): ReturnRequest =>
  ReturnRequest.reconstitute({
    id: 7,
    rmaNumber: 'RMA-2026-00000007',
    orderId: 1,
    customerId: RETURN_OWNER_ID,
    status,
    reasonCategory: ReturnReasonCategoryEnum.DEFECTIVE,
    notes: null,
    requestedAt: new Date('2026-06-10T00:00:00Z'),
    authorizedAt: new Date('2026-06-11T00:00:00Z'),
    closedAt: null,
    lines: [
      new ReturnLine({
        id: 71,
        returnRequestId: 7,
        orderLineId: 10,
        quantity: 2,
        condition: null,
        disposition: null,
        lineRefundAmountMinor: null,
      }),
      new ReturnLine({
        id: 72,
        returnRequestId: 7,
        orderLineId: 20,
        quantity: 1,
        condition: null,
        disposition: null,
        lineRefundAmountMinor: null,
      }),
    ],
    version: 3,
  });

// The order snapshot the reader hands back: orderLine 10 → variant 100, orderLine 20 →
// variant 200 (so a `restock` line resolves its variant).
const buildSnapshot = (): IReturnOrderSnapshot => ({
  orderId: 1,
  customerId: RETURN_OWNER_ID,
  status: 'delivered' as IReturnOrderSnapshot['status'],
  fulfillmentStatus: 'delivered' as IReturnOrderSnapshot['fulfillmentStatus'],
  shippedAt: new Date('2026-06-01T00:00:00Z'),
  deliveredAt: new Date('2026-06-03T00:00:00Z'),
  lines: [
    { orderLineId: 10, variantId: 100, quantity: 2, cancelledQuantity: 0 },
    { orderLineId: 20, variantId: 200, quantity: 1, cancelledQuantity: 0 },
  ],
});

const makeHarness = (
  options: { snapshot?: IReturnOrderSnapshot | null; restockFailure?: Error } = {},
): {
  useCase: InspectAndDispositionUseCase;
  repository: FakeReturnRequestRepository;
  restockGateway: FakeInventoryRestockGateway;
  publisher: SpyReturnEventsPublisher;
} => {
  const logger = makePinoLoggerMock() as unknown as PinoLogger;
  const transactionPort = new FakeTransactionPort();
  const repository = new FakeReturnRequestRepository();
  const orderReader = new FakeReturnOrderReader(
    options.snapshot === undefined ? buildSnapshot() : options.snapshot,
  );
  const restockGateway = new FakeInventoryRestockGateway(options.restockFailure ?? null);
  const publisher = new SpyReturnEventsPublisher();
  const useCase = new InspectAndDispositionUseCase(
    transactionPort,
    repository,
    orderReader,
    restockGateway,
    publisher,
    logger,
  );
  return { useCase, repository, restockGateway, publisher };
};

// Inspect payload covering both lines. Disposition per line is configurable so a spec can
// mix restock / scrap.
const payload = (
  rmaId: number,
  line71Disposition: ReturnDispositionEnum,
  line72Disposition: ReturnDispositionEnum,
): IRetailReturnInspectPayload => ({
  rmaId,
  actorId: WAREHOUSE_ID,
  correlationId: 'corr-inspect',
  lines: [
    {
      returnLineId: 71,
      condition: ReturnLineConditionEnum.NEW,
      disposition: line71Disposition,
      lineRefundAmountMinor: 1500,
    },
    {
      returnLineId: 72,
      condition: ReturnLineConditionEnum.DAMAGED,
      disposition: line72Disposition,
      lineRefundAmountMinor: 0,
    },
  ],
});

describe('InspectAndDispositionUseCase', () => {
  it('records condition/disposition/refund per line and walks received → inspected', async () => {
    const { useCase, repository } = makeHarness();
    repository.seed(buildReturnAt(ReturnStatusEnum.RECEIVED));

    const view = await useCase.execute(
      payload(7, ReturnDispositionEnum.RESTOCK, ReturnDispositionEnum.SCRAP),
    );

    expect(view.status).toBe(ReturnStatusEnum.INSPECTED);
    expect(view.version).toBe(4); // seeded at version 3, markInspected bumps to 4

    const line71 = view.lines.find((line) => line.id === 71)!;
    const line72 = view.lines.find((line) => line.id === 72)!;
    expect(line71).toMatchObject({
      condition: ReturnLineConditionEnum.NEW,
      disposition: ReturnDispositionEnum.RESTOCK,
      lineRefundAmountMinor: 1500,
    });
    expect(line72).toMatchObject({
      condition: ReturnLineConditionEnum.DAMAGED,
      disposition: ReturnDispositionEnum.SCRAP,
      lineRefundAmountMinor: 0,
    });
  });

  it('calls Restock exactly once carrying ALL restock lines (scrap/quarantine excluded)', async () => {
    const { useCase, repository, restockGateway, publisher } = makeHarness();
    repository.seed(buildReturnAt(ReturnStatusEnum.RECEIVED));

    await useCase.execute(payload(7, ReturnDispositionEnum.RESTOCK, ReturnDispositionEnum.SCRAP));

    expect(restockGateway.calls).toHaveLength(1);
    const sent = restockGateway.calls[0];
    expect(sent.returnRequestId).toBe(7);
    // Only the restock line (71 → variant 100, qty 2) — the scrapped line is excluded.
    expect(sent.lines).toEqual([
      { returnLineId: 71, variantId: 100, stockLocationId: 'default-warehouse', quantity: 2 },
    ]);
    expect(sent.actorId).toBe(WAREHOUSE_ID);

    // The inspected event carries the restocked-line count.
    expect(publisher.inspected).toHaveLength(1);
    expect(publisher.inspected[0]).toMatchObject({
      rmaId: 7,
      rmaNumber: 'RMA-2026-00000007',
      restockedLineCount: 1,
      eventVersion: 'v1',
      correlationId: 'corr-inspect',
    });
  });

  it('restocks BOTH lines when both are dispositioned restock', async () => {
    const { useCase, repository, restockGateway } = makeHarness();
    repository.seed(buildReturnAt(ReturnStatusEnum.RECEIVED));

    await useCase.execute(payload(7, ReturnDispositionEnum.RESTOCK, ReturnDispositionEnum.RESTOCK));

    expect(restockGateway.calls).toHaveLength(1);
    expect(restockGateway.calls[0].lines).toEqual([
      { returnLineId: 71, variantId: 100, stockLocationId: 'default-warehouse', quantity: 2 },
      { returnLineId: 72, variantId: 200, stockLocationId: 'default-warehouse', quantity: 1 },
    ]);
  });

  it('makes NO inventory call when no line is dispositioned restock', async () => {
    const { useCase, repository, restockGateway, publisher } = makeHarness();
    repository.seed(buildReturnAt(ReturnStatusEnum.RECEIVED));

    const view = await useCase.execute(
      payload(7, ReturnDispositionEnum.SCRAP, ReturnDispositionEnum.QUARANTINE),
    );

    expect(view.status).toBe(ReturnStatusEnum.INSPECTED);
    expect(restockGateway.calls).toHaveLength(0);
    expect(publisher.inspected[0].restockedLineCount).toBe(0);
  });

  it('rejects an unknown returnLineId with RETURN_LINE_NOT_FOUND (404)', async () => {
    const { useCase, repository, restockGateway } = makeHarness();
    repository.seed(buildReturnAt(ReturnStatusEnum.RECEIVED));

    const bad: IRetailReturnInspectPayload = {
      rmaId: 7,
      actorId: WAREHOUSE_ID,
      correlationId: 'corr-inspect',
      lines: [
        {
          returnLineId: 999,
          condition: ReturnLineConditionEnum.NEW,
          disposition: ReturnDispositionEnum.RESTOCK,
          lineRefundAmountMinor: 100,
        },
      ],
    };

    await expect(useCase.execute(bad)).rejects.toMatchObject({
      code: ReturnErrorCodeEnum.RETURN_LINE_NOT_FOUND,
    });
    expect(restockGateway.calls).toHaveLength(0);
  });

  it('rejects an incomplete inspection (a line left out) with RETURN_INSPECTION_INVALID (400)', async () => {
    const { useCase, repository } = makeHarness();
    repository.seed(buildReturnAt(ReturnStatusEnum.RECEIVED));

    const incomplete: IRetailReturnInspectPayload = {
      rmaId: 7,
      actorId: WAREHOUSE_ID,
      correlationId: 'corr-inspect',
      lines: [
        {
          returnLineId: 71,
          condition: ReturnLineConditionEnum.NEW,
          disposition: ReturnDispositionEnum.RESTOCK,
          lineRefundAmountMinor: 100,
        },
      ],
    };

    await expect(useCase.execute(incomplete)).rejects.toMatchObject({
      code: ReturnErrorCodeEnum.RETURN_INSPECTION_INVALID,
    });
  });

  it('rejects a missing RMA with RETURN_NOT_FOUND (404)', async () => {
    const { useCase } = makeHarness();

    await expect(
      useCase.execute(payload(404, ReturnDispositionEnum.RESTOCK, ReturnDispositionEnum.SCRAP)),
    ).rejects.toMatchObject({ code: ReturnErrorCodeEnum.RETURN_NOT_FOUND });
  });

  it('rejects inspecting a non-received RMA with RETURN_INVALID_STATUS_TRANSITION (409)', async () => {
    const { useCase, repository, restockGateway } = makeHarness();
    repository.seed(buildReturnAt(ReturnStatusEnum.AUTHORIZED));

    await expect(
      useCase.execute(payload(7, ReturnDispositionEnum.SCRAP, ReturnDispositionEnum.SCRAP)),
    ).rejects.toMatchObject({ code: ReturnErrorCodeEnum.RETURN_INVALID_STATUS_TRANSITION });
    expect(restockGateway.calls).toHaveLength(0);
  });

  it('does NOT roll back the inspection when the restock gateway fails (retry-then-log)', async () => {
    const { useCase, repository, publisher } = makeHarness({
      restockFailure: new Error('inventory unreachable'),
    });
    repository.seed(buildReturnAt(ReturnStatusEnum.RECEIVED));

    // The restock fails (and is retried-then-logged), but the inspection is committed and
    // the view comes back inspected — the after-commit eventual-consistency posture.
    const view = await useCase.execute(
      payload(7, ReturnDispositionEnum.RESTOCK, ReturnDispositionEnum.SCRAP),
    );

    expect(view.status).toBe(ReturnStatusEnum.INSPECTED);
    expect(repository.saved.at(-1)?.status).toBe(ReturnStatusEnum.INSPECTED);
    // The inspected event still fires post-commit.
    expect(publisher.inspected).toHaveLength(1);
  });
});
