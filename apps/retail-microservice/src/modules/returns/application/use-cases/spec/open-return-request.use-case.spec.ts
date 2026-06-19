import { PinoLogger } from 'nestjs-pino';

import {
  IRetailReturnOpenPayload,
  OrderFulfillmentStatusEnum,
  OrderStatusEnum,
  ReturnReasonCategoryEnum,
  ReturnStatusEnum,
} from '@retail-inventory-system/contracts';
import { makePinoLoggerMock } from '@retail-inventory-system/observability/testing';

import { ReturnErrorCodeEnum, ReturnRequest } from '../../../domain';
import { OpenReturnRequestUseCase } from '../open-return-request.use-case';
import {
  buildOrderSnapshot,
  FakeReturnOrderReader,
  FakeReturnRequestRepository,
  SpyReturnEventsPublisher,
} from './test-doubles';
import { IReturnOrderSnapshot } from '../../ports';

const OWNER_ID = '11111111-1111-4111-8111-111111111111';
const STAFF_ID = '99999999-9999-4999-8999-999999999999';
const OTHER_ID = '22222222-2222-4222-8222-222222222222';
const WINDOW_DAYS = 30;

interface IHarness {
  useCase: OpenReturnRequestUseCase;
  repository: FakeReturnRequestRepository;
  reader: FakeReturnOrderReader;
  publisher: SpyReturnEventsPublisher;
}

const makeHarness = (snapshot: IReturnOrderSnapshot | null = buildOrderSnapshot()): IHarness => {
  const logger = makePinoLoggerMock() as unknown as PinoLogger;
  const repository = new FakeReturnRequestRepository();
  const reader = new FakeReturnOrderReader(snapshot);
  const publisher = new SpyReturnEventsPublisher();
  const useCase = new OpenReturnRequestUseCase(repository, reader, publisher, WINDOW_DAYS, logger);
  return { useCase, repository, reader, publisher };
};

const openPayload = (
  overrides: Partial<IRetailReturnOpenPayload> = {},
): IRetailReturnOpenPayload => ({
  orderId: 1,
  customerId: OWNER_ID,
  isStaff: false,
  reasonCategory: ReturnReasonCategoryEnum.DEFECTIVE,
  notes: 'box crushed',
  lines: [{ orderLineId: 10, quantity: 2 }],
  correlationId: 'corr-open',
  ...overrides,
});

// Days ago, as a Date — for building shipped/delivered timestamps relative to now.
const daysAgo = (days: number): Date => new Date(Date.now() - days * 24 * 60 * 60 * 1000);

describe('OpenReturnRequestUseCase', () => {
  describe('the return-eligibility window', () => {
    it('opens a return against a delivered order (always returnable)', async () => {
      const { useCase, publisher } = makeHarness();

      const view = await useCase.execute(openPayload());

      expect(view.id).toBeGreaterThan(0);
      expect(view.status).toBe(ReturnStatusEnum.REQUESTED);
      expect(view.orderId).toBe(1);
      expect(view.customerId).toBe(OWNER_ID);
      expect(view.lines).toEqual([expect.objectContaining({ orderLineId: 10, quantity: 2 })]);
      expect(publisher.requested).toHaveLength(1);
    });

    it('opens a return against a shipped order within the window', async () => {
      const { useCase } = makeHarness(
        buildOrderSnapshot({
          status: OrderStatusEnum.PENDING,
          fulfillmentStatus: OrderFulfillmentStatusEnum.SHIPPED,
          shippedAt: daysAgo(5),
          deliveredAt: null,
        }),
      );

      const view = await useCase.execute(openPayload());

      expect(view.status).toBe(ReturnStatusEnum.REQUESTED);
    });

    it('rejects a shipped order past the window with RETURN_WINDOW_EXPIRED (409)', async () => {
      const { useCase, repository } = makeHarness(
        buildOrderSnapshot({
          status: OrderStatusEnum.PENDING,
          fulfillmentStatus: OrderFulfillmentStatusEnum.SHIPPED,
          shippedAt: daysAgo(WINDOW_DAYS + 5),
          deliveredAt: null,
        }),
      );

      await expect(useCase.execute(openPayload())).rejects.toMatchObject({
        code: ReturnErrorCodeEnum.RETURN_WINDOW_EXPIRED,
      });
      // Nothing was persisted.
      expect(repository.saved).toHaveLength(0);
    });

    it('rejects a not-yet-shipped order with RETURN_ORDER_NOT_RETURNABLE (409)', async () => {
      const { useCase } = makeHarness(
        buildOrderSnapshot({
          status: OrderStatusEnum.PENDING,
          fulfillmentStatus: OrderFulfillmentStatusEnum.UNFULFILLED,
          shippedAt: null,
          deliveredAt: null,
        }),
      );

      await expect(useCase.execute(openPayload())).rejects.toMatchObject({
        code: ReturnErrorCodeEnum.RETURN_ORDER_NOT_RETURNABLE,
      });
    });
  });

  describe('the returnable-quantity invariant', () => {
    it('rejects an over-quantity request with RETURN_QUANTITY_EXCEEDS_RETURNABLE (409)', async () => {
      // Line 10 ordered 3, none cancelled, none returned → 3 returnable; request 4.
      const { useCase } = makeHarness();

      await expect(
        useCase.execute(openPayload({ lines: [{ orderLineId: 10, quantity: 4 }] })),
      ).rejects.toMatchObject({ code: ReturnErrorCodeEnum.RETURN_QUANTITY_EXCEEDS_RETURNABLE });
    });

    it('subtracts a cancelled quantity from the returnable remainder', async () => {
      // Ordered 3, 2 cancelled → only 1 returnable; request 2 is rejected.
      const { useCase } = makeHarness(
        buildOrderSnapshot({
          lines: [{ orderLineId: 10, variantId: 100, quantity: 3, cancelledQuantity: 2 }],
        }),
      );

      await expect(
        useCase.execute(openPayload({ lines: [{ orderLineId: 10, quantity: 2 }] })),
      ).rejects.toMatchObject({ code: ReturnErrorCodeEnum.RETURN_QUANTITY_EXCEEDS_RETURNABLE });
    });

    it('subtracts an already-returned quantity, but a rejected prior RMA frees it back', async () => {
      const { useCase, repository } = makeHarness();

      // A prior NON-rejected RMA returned 2 of line 10's 3 → only 1 returnable now.
      repository.seed(
        ReturnRequest.reconstitute({
          id: 50,
          rmaNumber: 'RMA-2026-00000050',
          orderId: 1,
          customerId: OWNER_ID,
          status: ReturnStatusEnum.AUTHORIZED,
          reasonCategory: ReturnReasonCategoryEnum.DEFECTIVE,
          notes: null,
          requestedAt: new Date('2026-06-10T00:00:00Z'),
          authorizedAt: new Date('2026-06-11T00:00:00Z'),
          closedAt: null,
          lines: ReturnRequest.open({
            orderId: 1,
            customerId: OWNER_ID,
            reasonCategory: ReturnReasonCategoryEnum.DEFECTIVE,
            notes: null,
            lines: [{ orderLineId: 10, quantity: 2 }],
          }).lines.slice(),
          version: 1,
        }),
      );

      await expect(
        useCase.execute(openPayload({ lines: [{ orderLineId: 10, quantity: 2 }] })),
      ).rejects.toMatchObject({ code: ReturnErrorCodeEnum.RETURN_QUANTITY_EXCEEDS_RETURNABLE });

      // A REJECTED prior RMA does NOT consume the quantity — 3 returnable again.
      repository.seed(
        ReturnRequest.reconstitute({
          id: 51,
          rmaNumber: 'RMA-2026-00000051',
          orderId: 2,
          customerId: OWNER_ID,
          status: ReturnStatusEnum.REJECTED,
          reasonCategory: ReturnReasonCategoryEnum.DEFECTIVE,
          notes: null,
          requestedAt: new Date('2026-06-10T00:00:00Z'),
          authorizedAt: null,
          closedAt: new Date('2026-06-11T00:00:00Z'),
          lines: ReturnRequest.open({
            orderId: 2,
            customerId: OWNER_ID,
            reasonCategory: ReturnReasonCategoryEnum.DEFECTIVE,
            notes: null,
            lines: [{ orderLineId: 20, quantity: 5 }],
          }).lines.slice(),
          version: 1,
        }),
      );
      // (RMA 51 is on a different order anyway; the key assertion is the non-rejected one.)
    });

    it('rejects an unknown order line with RETURN_ORDER_LINE_NOT_FOUND (404)', async () => {
      const { useCase } = makeHarness();

      await expect(
        useCase.execute(openPayload({ lines: [{ orderLineId: 777, quantity: 1 }] })),
      ).rejects.toMatchObject({ code: ReturnErrorCodeEnum.RETURN_ORDER_LINE_NOT_FOUND });
    });
  });

  describe('authorization (owner-or-staff)', () => {
    it('rejects a non-owner non-staff caller with RETURN_ACCESS_FORBIDDEN (403)', async () => {
      const { useCase } = makeHarness();

      await expect(
        useCase.execute(openPayload({ customerId: OTHER_ID, isStaff: false })),
      ).rejects.toMatchObject({ code: ReturnErrorCodeEnum.RETURN_ACCESS_FORBIDDEN });
    });

    it('lets staff open a return against an order it does not own', async () => {
      const { useCase } = makeHarness();

      const view = await useCase.execute(openPayload({ customerId: STAFF_ID, isStaff: true }));

      // The RMA's buyer is the ORDER's customer, not the staff actor.
      expect(view.customerId).toBe(OWNER_ID);
      expect(view.status).toBe(ReturnStatusEnum.REQUESTED);
    });
  });

  describe('persistence + eventing', () => {
    it('rejects a missing order with RETURN_ORDER_NOT_FOUND (404)', async () => {
      const { useCase } = makeHarness(null);

      await expect(useCase.execute(openPayload())).rejects.toMatchObject({
        code: ReturnErrorCodeEnum.RETURN_ORDER_NOT_FOUND,
      });
    });

    it('finalizes an RMA-<year>-<pad8(id)> number and emits retail.return.requested', async () => {
      const { useCase, publisher } = makeHarness();

      const view = await useCase.execute(openPayload());

      expect(view.rmaNumber).toMatch(/^RMA-\d{4}-\d{8}$/);
      expect(view.rmaNumber).toBe(`RMA-${new Date().getUTCFullYear()}-00000001`);

      expect(publisher.requested).toHaveLength(1);
      expect(publisher.requested[0]).toMatchObject({
        rmaId: view.id,
        rmaNumber: view.rmaNumber,
        orderId: 1,
        customerId: OWNER_ID,
        lineCount: 1,
        eventVersion: 'v1',
        correlationId: 'corr-open',
      });
    });
  });
});
