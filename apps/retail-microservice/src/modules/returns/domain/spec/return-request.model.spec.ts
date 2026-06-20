import { ReturnReasonCategoryEnum, ReturnStatusEnum } from '@retail-inventory-system/contracts';

import {
  IOpenReturnRequestInput,
  ReturnDomainException,
  ReturnErrorCodeEnum,
  ReturnRequest,
} from '..';

const openInput = (overrides: Partial<IOpenReturnRequestInput> = {}): IOpenReturnRequestInput => ({
  orderId: 1,
  customerId: '11111111-1111-4111-8111-111111111111',
  reasonCategory: ReturnReasonCategoryEnum.DEFECTIVE,
  notes: null,
  lines: [{ orderLineId: 10, quantity: 2 }],
  ...overrides,
});

// Walks the request to a given status by replaying the lifecycle transitions.
const authorizedRequest = (): ReturnRequest => {
  const request = ReturnRequest.open(openInput());
  request.authorize(new Date('2026-06-19T10:00:00Z'));
  return request;
};

describe('ReturnRequest', () => {
  describe('open factory', () => {
    it('opens a REQUESTED request at version 0 with requestedAt stamped, null rma/authorized/closed', () => {
      const now = new Date('2026-06-19T09:00:00Z');
      const request = ReturnRequest.open(openInput({ notes: 'box crushed' }), now);

      expect(request.status).toBe(ReturnStatusEnum.REQUESTED);
      expect(request.version).toBe(0);
      expect(request.id).toBeNull();
      expect(request.rmaNumber).toBeNull();
      expect(request.orderId).toBe(1);
      expect(request.customerId).toBe('11111111-1111-4111-8111-111111111111');
      expect(request.reasonCategory).toBe(ReturnReasonCategoryEnum.DEFECTIVE);
      expect(request.notes).toBe('box crushed');
      expect(request.requestedAt).toEqual(now);
      expect(request.authorizedAt).toBeNull();
      expect(request.closedAt).toBeNull();
    });

    it('builds the ReturnLine children with null inspection fields until inspected', () => {
      const request = ReturnRequest.open(
        openInput({
          lines: [
            { orderLineId: 10, quantity: 2 },
            { orderLineId: 11, quantity: 1 },
          ],
        }),
      );

      expect(request.lines).toHaveLength(2);
      expect(request.lines[0].orderLineId).toBe(10);
      expect(request.lines[0].quantity).toBe(2);
      // The children are null-id / null-parent until persistence assigns the BIGINTs.
      expect(request.lines[0].id).toBeNull();
      expect(request.lines[0].returnRequestId).toBeNull();
      // No condition/disposition/refund until inspection.
      expect(request.lines[0].condition).toBeNull();
      expect(request.lines[0].disposition).toBeNull();
      expect(request.lines[0].lineRefundAmountMinor).toBeNull();
    });

    it('rejects an empty lines array with RETURN_NO_LINES', () => {
      expect(() => ReturnRequest.open(openInput({ lines: [] }))).toThrow(ReturnDomainException);
      try {
        ReturnRequest.open(openInput({ lines: [] }));
      } catch (err) {
        expect((err as ReturnDomainException).code).toBe(ReturnErrorCodeEnum.RETURN_NO_LINES);
      }
    });

    it('rejects a non-positive line quantity (the child enforces its own shape)', () => {
      expect(() =>
        ReturnRequest.open(openInput({ lines: [{ orderLineId: 10, quantity: 0 }] })),
      ).toThrow(ReturnDomainException);
    });
  });

  describe('the happy-path state machine', () => {
    it('walks requested → authorized → received → inspected → closed, bumping version each step', () => {
      const request = ReturnRequest.open(openInput());
      expect(request.version).toBe(0);

      const authorizedAt = new Date('2026-06-19T10:00:00Z');
      request.authorize(authorizedAt);
      expect(request.status).toBe(ReturnStatusEnum.AUTHORIZED);
      expect(request.authorizedAt).toEqual(authorizedAt);
      expect(request.version).toBe(1);

      request.receive();
      expect(request.status).toBe(ReturnStatusEnum.RECEIVED);
      expect(request.version).toBe(2);

      request.markInspected();
      expect(request.status).toBe(ReturnStatusEnum.INSPECTED);
      expect(request.version).toBe(3);

      const closedAt = new Date('2026-06-20T12:00:00Z');
      request.close(closedAt);
      expect(request.status).toBe(ReturnStatusEnum.CLOSED);
      expect(request.closedAt).toEqual(closedAt);
      expect(request.version).toBe(4);
    });
  });

  describe('reject', () => {
    it('walks requested → rejected, stamps closedAt, and bumps version', () => {
      const request = ReturnRequest.open(openInput());
      const closedAt = new Date('2026-06-19T11:00:00Z');

      request.reject(closedAt);

      expect(request.status).toBe(ReturnStatusEnum.REJECTED);
      expect(request.closedAt).toEqual(closedAt);
      expect(request.version).toBe(1);
    });
  });

  describe('illegal transitions', () => {
    it('rejects authorize from a non-requested state (e.g. received)', () => {
      const request = authorizedRequest();
      request.receive();

      try {
        request.authorize(new Date());
        fail('expected authorize to throw');
      } catch (err) {
        expect(err).toBeInstanceOf(ReturnDomainException);
        expect((err as ReturnDomainException).code).toBe(
          ReturnErrorCodeEnum.RETURN_INVALID_STATUS_TRANSITION,
        );
      }
    });

    it('rejects close from requested (must be inspected first)', () => {
      const request = ReturnRequest.open(openInput());

      try {
        request.close(new Date());
        fail('expected close to throw');
      } catch (err) {
        expect((err as ReturnDomainException).code).toBe(
          ReturnErrorCodeEnum.RETURN_INVALID_STATUS_TRANSITION,
        );
      }
      // A rejected transition leaves the request untouched.
      expect(request.status).toBe(ReturnStatusEnum.REQUESTED);
      expect(request.version).toBe(0);
    });

    it('rejects receive from requested (must be authorized first)', () => {
      const request = ReturnRequest.open(openInput());
      expect(() => request.receive()).toThrow(ReturnDomainException);
    });

    it('rejects reject from an authorized state (rejection is requested-only)', () => {
      const request = authorizedRequest();
      expect(() => request.reject(new Date())).toThrow(ReturnDomainException);
    });

    it('rejects markInspected from authorized (must be received first)', () => {
      const request = authorizedRequest();
      expect(() => request.markInspected()).toThrow(ReturnDomainException);
    });
  });

  describe('reconstitute', () => {
    it('rebuilds an inspected request from storage and can still be closed', () => {
      const request = ReturnRequest.reconstitute({
        id: 7,
        rmaNumber: 'RMA-2026-00000007',
        orderId: 1,
        customerId: '11111111-1111-4111-8111-111111111111',
        status: ReturnStatusEnum.INSPECTED,
        reasonCategory: ReturnReasonCategoryEnum.DEFECTIVE,
        notes: null,
        requestedAt: new Date('2026-06-19T09:00:00Z'),
        authorizedAt: new Date('2026-06-19T10:00:00Z'),
        closedAt: null,
        lines: ReturnRequest.open(openInput()).lines.slice(),
        version: 3,
      });

      expect(request.id).toBe(7);
      expect(request.rmaNumber).toBe('RMA-2026-00000007');
      expect(request.status).toBe(ReturnStatusEnum.INSPECTED);
      expect(request.version).toBe(3);

      request.close(new Date('2026-06-20T00:00:00Z'));
      expect(request.status).toBe(ReturnStatusEnum.CLOSED);
      expect(request.version).toBe(4);
    });
  });
});
