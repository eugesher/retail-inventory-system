import { FulfillmentStatusEnum } from '@retail-inventory-system/contracts';

import { Fulfillment, ICreateFulfillmentInput, OrderDomainException, OrderErrorCodeEnum } from '..';

const createInput = (
  overrides: Partial<ICreateFulfillmentInput> = {},
): ICreateFulfillmentInput => ({
  orderId: 1,
  stockLocationId: 'default-warehouse',
  lines: [{ orderLineId: 10, quantity: 2 }],
  ...overrides,
});

describe('Fulfillment', () => {
  describe('create factory', () => {
    it('opens a PENDING fulfillment at version 0 with null tracking/carrier/timestamps', () => {
      const fulfillment = Fulfillment.create(createInput());

      expect(fulfillment.status).toBe(FulfillmentStatusEnum.PENDING);
      expect(fulfillment.version).toBe(0);
      expect(fulfillment.id).toBeNull();
      expect(fulfillment.orderId).toBe(1);
      expect(fulfillment.stockLocationId).toBe('default-warehouse');
      expect(fulfillment.trackingNumber).toBeNull();
      expect(fulfillment.carrier).toBeNull();
      expect(fulfillment.shippedAt).toBeNull();
      expect(fulfillment.deliveredAt).toBeNull();
    });

    it('builds the FulfillmentLine children from the input lines', () => {
      const fulfillment = Fulfillment.create(
        createInput({
          lines: [
            { orderLineId: 10, quantity: 2 },
            { orderLineId: 11, quantity: 1 },
          ],
        }),
      );

      expect(fulfillment.lines).toHaveLength(2);
      expect(fulfillment.lines[0].orderLineId).toBe(10);
      expect(fulfillment.lines[0].quantity).toBe(2);
      expect(fulfillment.lines[1].orderLineId).toBe(11);
      // The children are null-id / null-parent until persistence assigns the BIGINTs.
      expect(fulfillment.lines[0].id).toBeNull();
      expect(fulfillment.lines[0].fulfillmentId).toBeNull();
    });

    it('rejects an empty lines array with FULFILLMENT_NO_LINES', () => {
      expect(() => Fulfillment.create(createInput({ lines: [] }))).toThrow(OrderDomainException);
      try {
        Fulfillment.create(createInput({ lines: [] }));
      } catch (err) {
        expect((err as OrderDomainException).code).toBe(OrderErrorCodeEnum.FULFILLMENT_NO_LINES);
      }
    });

    it('rejects a non-positive line quantity (the child enforces its own shape)', () => {
      expect(() =>
        Fulfillment.create(createInput({ lines: [{ orderLineId: 10, quantity: 0 }] })),
      ).toThrow(OrderDomainException);
    });
  });

  describe('ship', () => {
    it('walks pending → shipped, stamps shippedAt + tracking, and bumps version', () => {
      const fulfillment = Fulfillment.create(createInput());
      const shippedAt = new Date('2026-06-15T10:00:00Z');

      fulfillment.ship({ trackingNumber: 'TRACK-1', carrier: 'ups', shippedAt });

      expect(fulfillment.status).toBe(FulfillmentStatusEnum.SHIPPED);
      expect(fulfillment.trackingNumber).toBe('TRACK-1');
      expect(fulfillment.carrier).toBe('ups');
      expect(fulfillment.shippedAt).toEqual(shippedAt);
      expect(fulfillment.version).toBe(1);
    });

    it.each([
      ['null', null],
      ['empty', ''],
      ['blank', '   '],
    ])(
      'rejects a %s trackingNumber with FULFILLMENT_TRACKING_REQUIRED',
      (_label, trackingNumber) => {
        const fulfillment = Fulfillment.create(createInput());

        try {
          fulfillment.ship({ trackingNumber, carrier: 'ups', shippedAt: new Date() });
          fail('expected ship to throw');
        } catch (err) {
          expect(err).toBeInstanceOf(OrderDomainException);
          expect((err as OrderDomainException).code).toBe(
            OrderErrorCodeEnum.FULFILLMENT_TRACKING_REQUIRED,
          );
        }
        // A rejected ship leaves the fulfillment untouched (still pending, version 0).
        expect(fulfillment.status).toBe(FulfillmentStatusEnum.PENDING);
        expect(fulfillment.version).toBe(0);
      },
    );

    it('rejects shipping an already-shipped fulfillment (illegal transition)', () => {
      const fulfillment = Fulfillment.create(createInput());
      fulfillment.ship({ trackingNumber: 'TRACK-1', carrier: 'ups', shippedAt: new Date() });

      try {
        fulfillment.ship({ trackingNumber: 'TRACK-2', carrier: 'ups', shippedAt: new Date() });
        fail('expected ship to throw');
      } catch (err) {
        expect((err as OrderDomainException).code).toBe(
          OrderErrorCodeEnum.FULFILLMENT_INVALID_STATUS_TRANSITION,
        );
      }
    });
  });

  describe('markDelivered', () => {
    it('walks shipped → delivered, stamps deliveredAt, and bumps version', () => {
      const fulfillment = Fulfillment.create(createInput());
      fulfillment.ship({ trackingNumber: 'TRACK-1', carrier: 'ups', shippedAt: new Date() });
      const deliveredAt = new Date('2026-06-18T12:00:00Z');

      fulfillment.markDelivered(deliveredAt);

      expect(fulfillment.status).toBe(FulfillmentStatusEnum.DELIVERED);
      expect(fulfillment.deliveredAt).toEqual(deliveredAt);
      expect(fulfillment.version).toBe(2);
    });

    it('rejects delivering a pending (not-yet-shipped) fulfillment', () => {
      const fulfillment = Fulfillment.create(createInput());

      try {
        fulfillment.markDelivered(new Date());
        fail('expected markDelivered to throw');
      } catch (err) {
        expect((err as OrderDomainException).code).toBe(
          OrderErrorCodeEnum.FULFILLMENT_INVALID_STATUS_TRANSITION,
        );
      }
    });
  });

  describe('cancel', () => {
    it('walks pending → cancelled and bumps version', () => {
      const fulfillment = Fulfillment.create(createInput());

      fulfillment.cancel();

      expect(fulfillment.status).toBe(FulfillmentStatusEnum.CANCELLED);
      expect(fulfillment.version).toBe(1);
    });

    it('rejects cancelling a shipped fulfillment (protects Cancel Order)', () => {
      const fulfillment = Fulfillment.create(createInput());
      fulfillment.ship({ trackingNumber: 'TRACK-1', carrier: 'ups', shippedAt: new Date() });

      try {
        fulfillment.cancel();
        fail('expected cancel to throw');
      } catch (err) {
        expect((err as OrderDomainException).code).toBe(
          OrderErrorCodeEnum.FULFILLMENT_INVALID_STATUS_TRANSITION,
        );
      }
    });

    it('rejects cancelling a delivered fulfillment', () => {
      const fulfillment = Fulfillment.create(createInput());
      fulfillment.ship({ trackingNumber: 'TRACK-1', carrier: 'ups', shippedAt: new Date() });
      fulfillment.markDelivered(new Date());

      expect(() => fulfillment.cancel()).toThrow(OrderDomainException);
    });
  });

  describe('reconstitute', () => {
    it('rebuilds a shipped fulfillment from storage with its lines', () => {
      const fulfillment = Fulfillment.reconstitute({
        id: 5,
        orderId: 1,
        stockLocationId: 'default-warehouse',
        status: FulfillmentStatusEnum.SHIPPED,
        trackingNumber: 'TRACK-1',
        carrier: 'ups',
        shippedAt: new Date('2026-06-15T10:00:00Z'),
        deliveredAt: null,
        lines: Fulfillment.create(createInput()).lines.slice(),
        version: 1,
      });

      expect(fulfillment.id).toBe(5);
      expect(fulfillment.status).toBe(FulfillmentStatusEnum.SHIPPED);
      expect(fulfillment.trackingNumber).toBe('TRACK-1');
      expect(fulfillment.version).toBe(1);
      // A reconstituted shipped fulfillment can still be delivered.
      fulfillment.markDelivered(new Date('2026-06-18T00:00:00Z'));
      expect(fulfillment.status).toBe(FulfillmentStatusEnum.DELIVERED);
    });
  });
});
