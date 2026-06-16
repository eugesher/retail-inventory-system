import {
  OrderFulfillmentStatusEnum,
  OrderLineStatusEnum,
  OrderPaymentStatusEnum,
  OrderStatusEnum,
} from '@retail-inventory-system/contracts';

import { Order, OrderDomainException, OrderLine } from '..';

const makeLine = (
  id: number | null,
  variantId: number,
  unitPriceMinor = 1000,
  quantity = 1,
): OrderLine =>
  new OrderLine({
    id,
    variantId,
    sku: `SKU-${variantId}`,
    nameSnapshot: `Variant ${variantId}`,
    quantity,
    unitPriceMinor,
  });

const placeOrder = (lines: OrderLine[] = [makeLine(null, 7, 1500, 2)]): Order =>
  Order.place({
    orderNumber: 'ORD-2026-PROVISIONAL',
    customerId: 'cust-1',
    currency: 'USD',
    lines,
    billingAddressId: 'addr-bill',
    shippingAddressId: 'addr-ship',
    sourceCartId: 'cart-1',
    placedAt: new Date('2026-06-10T00:00:00Z'),
  });

// A persisted order at any combination of the three status axes — the lifecycle/cancel
// mutators need a starting state other than the place-time `pending`/`unfulfilled`.
const reconstituteOrder = (opts: {
  status?: OrderStatusEnum;
  fulfillmentStatus?: OrderFulfillmentStatusEnum;
  paymentStatus?: OrderPaymentStatusEnum;
}): Order =>
  Order.reconstitute({
    id: 1,
    orderNumber: 'ORD-2026-00000001',
    customerId: 'cust-1',
    currency: 'USD',
    status: opts.status ?? OrderStatusEnum.PENDING,
    paymentStatus: opts.paymentStatus ?? OrderPaymentStatusEnum.AUTHORIZED,
    fulfillmentStatus: opts.fulfillmentStatus ?? OrderFulfillmentStatusEnum.UNFULFILLED,
    lines: [makeLine(10, 7, 1500, 2)],
    subtotalMinor: 3000,
    taxTotalMinor: 0,
    discountTotalMinor: 0,
    shippingTotalMinor: 0,
    grandTotalMinor: 3000,
    billingAddressId: 'addr-bill',
    shippingAddressId: 'addr-ship',
    sourceCartId: 'cart-1',
    placedAt: new Date('2026-06-10T00:00:00Z'),
    version: 3,
  });

describe('Order', () => {
  describe('place', () => {
    it('opens a PENDING / NONE / UNFULFILLED order at version 0 and derives the totals', () => {
      const order = placeOrder([makeLine(null, 7, 1500, 2), makeLine(null, 8, 999, 3)]);

      expect(order.status).toBe(OrderStatusEnum.PENDING);
      expect(order.paymentStatus).toBe(OrderPaymentStatusEnum.NONE);
      expect(order.fulfillmentStatus).toBe(OrderFulfillmentStatusEnum.UNFULFILLED);
      expect(order.version).toBe(0);
      expect(order.id).toBeNull();
      // 1500×2 + 999×3 = 3000 + 2997 = 5997
      expect(order.subtotalMinor).toBe(5997);
      expect(order.grandTotalMinor).toBe(5997);
      expect(order.taxTotalMinor).toBe(0);
      expect(order.discountTotalMinor).toBe(0);
      expect(order.shippingTotalMinor).toBe(0);
    });

    it('rejects placing an order with zero lines', () => {
      expect(() => placeOrder([])).toThrow(OrderDomainException);
    });

    it.each([
      ['empty', ''],
      ['too long', 'USDD'],
      ['too short', 'US'],
    ])('rejects a %s currency', (_label, currency) => {
      expect(() =>
        Order.place({
          orderNumber: 'ORD-2026-PROVISIONAL',
          customerId: null,
          currency,
          lines: [makeLine(null, 7)],
          billingAddressId: null,
          shippingAddressId: null,
          sourceCartId: null,
          placedAt: new Date(),
        }),
      ).toThrow(OrderDomainException);
    });
  });

  describe('three orthogonal status axes', () => {
    it('lets paymentStatus=captured coexist with fulfillmentStatus=unfulfilled and status=pending', () => {
      // The three axes evolve independently (ADR-028 §2): a captured payment does
      // not imply the order has shipped or moved off the pending lifecycle.
      const order = Order.reconstitute({
        id: 1,
        orderNumber: 'ORD-2026-00000001',
        customerId: 'cust-1',
        currency: 'USD',
        status: OrderStatusEnum.PENDING,
        paymentStatus: OrderPaymentStatusEnum.CAPTURED,
        fulfillmentStatus: OrderFulfillmentStatusEnum.UNFULFILLED,
        lines: [makeLine(10, 7, 1000, 2)],
        subtotalMinor: 2000,
        grandTotalMinor: 2000,
        billingAddressId: null,
        shippingAddressId: null,
        sourceCartId: null,
        placedAt: new Date('2026-06-10T00:00:00Z'),
        version: 3,
      });

      expect(order.paymentStatus).toBe(OrderPaymentStatusEnum.CAPTURED);
      expect(order.fulfillmentStatus).toBe(OrderFulfillmentStatusEnum.UNFULFILLED);
      expect(order.status).toBe(OrderStatusEnum.PENDING);
    });

    it('advancing payment does not move the lifecycle or fulfillment axes', () => {
      const order = placeOrder();

      order.markPaymentAuthorized();
      order.markPaymentCaptured();

      expect(order.paymentStatus).toBe(OrderPaymentStatusEnum.CAPTURED);
      // Untouched — orthogonality.
      expect(order.status).toBe(OrderStatusEnum.PENDING);
      expect(order.fulfillmentStatus).toBe(OrderFulfillmentStatusEnum.UNFULFILLED);
    });
  });

  describe('currency immutability', () => {
    it('keeps currency fixed after place (getter-only, no setter)', () => {
      const order = placeOrder();

      expect(() => {
        (order as unknown as { currency: string }).currency = 'EUR';
      }).toThrow();
      expect(order.currency).toBe('USD');
    });
  });

  describe('total invariant', () => {
    it('rejects a reconstituted order whose subtotal disagrees with Σ line totals', () => {
      expect(() =>
        Order.reconstitute({
          id: 1,
          orderNumber: 'ORD-2026-00000001',
          customerId: null,
          currency: 'USD',
          lines: [makeLine(10, 7, 1000, 2)], // Σ lineTotal = 2000
          subtotalMinor: 1999, // disagrees
          grandTotalMinor: 1999,
          billingAddressId: null,
          shippingAddressId: null,
          sourceCartId: null,
          placedAt: new Date(),
        }),
      ).toThrow(OrderDomainException);
    });

    it('rejects a grand total that does not reconcile subtotal + tax + shipping − discount', () => {
      expect(() =>
        Order.reconstitute({
          id: 1,
          orderNumber: 'ORD-2026-00000001',
          customerId: null,
          currency: 'USD',
          lines: [makeLine(10, 7, 1000, 2)], // Σ lineTotal = 2000
          subtotalMinor: 2000,
          taxTotalMinor: 100,
          shippingTotalMinor: 50,
          discountTotalMinor: 30,
          grandTotalMinor: 2000, // should be 2000 + 100 + 50 − 30 = 2120
          billingAddressId: null,
          shippingAddressId: null,
          sourceCartId: null,
          placedAt: new Date(),
        }),
      ).toThrow(OrderDomainException);
    });

    it('accepts a reconstituted order whose totals reconcile with tax/shipping/discount', () => {
      const order = Order.reconstitute({
        id: 1,
        orderNumber: 'ORD-2026-00000001',
        customerId: null,
        currency: 'USD',
        lines: [makeLine(10, 7, 1000, 2)], // Σ lineTotal = 2000
        subtotalMinor: 2000,
        taxTotalMinor: 100,
        shippingTotalMinor: 50,
        discountTotalMinor: 30,
        grandTotalMinor: 2120,
        billingAddressId: null,
        shippingAddressId: null,
        sourceCartId: null,
        placedAt: new Date(),
      });

      expect(order.grandTotalMinor).toBe(2120);
    });
  });

  describe('payment-status transitions', () => {
    it('markPaymentAuthorized moves none → authorized and bumps the version', () => {
      const order = placeOrder();

      order.markPaymentAuthorized();

      expect(order.paymentStatus).toBe(OrderPaymentStatusEnum.AUTHORIZED);
      expect(order.version).toBe(1);
    });

    it('markPaymentCaptured moves authorized → captured and bumps the version', () => {
      const order = placeOrder();
      order.markPaymentAuthorized();

      order.markPaymentCaptured();

      expect(order.paymentStatus).toBe(OrderPaymentStatusEnum.CAPTURED);
      expect(order.version).toBe(2);
    });

    it('rejects authorizing a payment that is not none', () => {
      const order = placeOrder();
      order.markPaymentAuthorized();

      expect(() => order.markPaymentAuthorized()).toThrow(OrderDomainException);
    });

    it('rejects capturing a payment that is not authorized', () => {
      const order = placeOrder();

      expect(() => order.markPaymentCaptured()).toThrow(OrderDomainException);
    });
  });

  describe('advanceFulfillment', () => {
    it('moves unfulfilled → partially-shipped and bumps the version', () => {
      const order = placeOrder();

      order.advanceFulfillment(OrderFulfillmentStatusEnum.PARTIALLY_SHIPPED);

      expect(order.fulfillmentStatus).toBe(OrderFulfillmentStatusEnum.PARTIALLY_SHIPPED);
      expect(order.version).toBe(1);
    });

    it('moves unfulfilled → shipped directly (a full single ship)', () => {
      const order = placeOrder();

      order.advanceFulfillment(OrderFulfillmentStatusEnum.SHIPPED);

      expect(order.fulfillmentStatus).toBe(OrderFulfillmentStatusEnum.SHIPPED);
    });

    it('allows a forward move that stays partially-shipped (a further partial ship)', () => {
      const order = placeOrder();
      order.advanceFulfillment(OrderFulfillmentStatusEnum.PARTIALLY_SHIPPED);

      expect(() =>
        order.advanceFulfillment(OrderFulfillmentStatusEnum.PARTIALLY_SHIPPED),
      ).not.toThrow();
      expect(order.fulfillmentStatus).toBe(OrderFulfillmentStatusEnum.PARTIALLY_SHIPPED);
    });

    it('rejects a strictly-backward move (shipped → partially-shipped)', () => {
      const order = placeOrder();
      order.advanceFulfillment(OrderFulfillmentStatusEnum.SHIPPED);

      expect(() => order.advanceFulfillment(OrderFulfillmentStatusEnum.PARTIALLY_SHIPPED)).toThrow(
        OrderDomainException,
      );
    });

    it('touches only the fulfillment axis (lifecycle + payment unchanged)', () => {
      const order = placeOrder();

      order.advanceFulfillment(OrderFulfillmentStatusEnum.SHIPPED);

      expect(order.status).toBe(OrderStatusEnum.PENDING);
      expect(order.paymentStatus).toBe(OrderPaymentStatusEnum.NONE);
    });
  });

  describe('cancel', () => {
    it('moves a pending order → cancelled and bumps the version', () => {
      const order = reconstituteOrder({ status: OrderStatusEnum.PENDING });

      order.cancel();

      expect(order.status).toBe(OrderStatusEnum.CANCELLED);
      expect(order.version).toBe(4);
    });

    it('cancels a confirmed order', () => {
      const order = reconstituteOrder({ status: OrderStatusEnum.CONFIRMED });

      order.cancel();

      expect(order.status).toBe(OrderStatusEnum.CANCELLED);
    });

    it('touches only the lifecycle axis (payment + fulfillment unchanged)', () => {
      const order = reconstituteOrder({
        status: OrderStatusEnum.PENDING,
        paymentStatus: OrderPaymentStatusEnum.CAPTURED,
        fulfillmentStatus: OrderFulfillmentStatusEnum.UNFULFILLED,
      });

      order.cancel();

      expect(order.paymentStatus).toBe(OrderPaymentStatusEnum.CAPTURED);
      expect(order.fulfillmentStatus).toBe(OrderFulfillmentStatusEnum.UNFULFILLED);
    });

    it.each([
      ['cancelled', OrderStatusEnum.CANCELLED],
      ['shipped', OrderStatusEnum.SHIPPED],
      ['delivered', OrderStatusEnum.DELIVERED],
    ])('rejects cancelling a %s order', (_label, status) => {
      const order = reconstituteOrder({ status });

      expect(() => order.cancel()).toThrow(OrderDomainException);
    });
  });

  describe('markDelivered', () => {
    it('moves a shipped order → delivered on both axes and bumps the version', () => {
      const order = reconstituteOrder({
        status: OrderStatusEnum.PENDING,
        fulfillmentStatus: OrderFulfillmentStatusEnum.SHIPPED,
      });

      order.markDelivered();

      expect(order.status).toBe(OrderStatusEnum.DELIVERED);
      expect(order.fulfillmentStatus).toBe(OrderFulfillmentStatusEnum.DELIVERED);
      expect(order.version).toBe(4);
    });

    it('delivers a partially-shipped order (the last shipment closes it out)', () => {
      const order = reconstituteOrder({
        status: OrderStatusEnum.PENDING,
        fulfillmentStatus: OrderFulfillmentStatusEnum.PARTIALLY_SHIPPED,
      });

      order.markDelivered();

      expect(order.status).toBe(OrderStatusEnum.DELIVERED);
      expect(order.fulfillmentStatus).toBe(OrderFulfillmentStatusEnum.DELIVERED);
    });

    it('rejects delivering an unfulfilled order (nothing shipped)', () => {
      const order = reconstituteOrder({
        fulfillmentStatus: OrderFulfillmentStatusEnum.UNFULFILLED,
      });

      expect(() => order.markDelivered()).toThrow(OrderDomainException);
    });

    it('rejects delivering a cancelled order', () => {
      const order = reconstituteOrder({
        status: OrderStatusEnum.CANCELLED,
        fulfillmentStatus: OrderFulfillmentStatusEnum.SHIPPED,
      });

      expect(() => order.markDelivered()).toThrow(OrderDomainException);
    });
  });

  describe('lines', () => {
    it('exposes its lines, defaulting them to the ALLOCATED sentinel at place-time', () => {
      const order = placeOrder([makeLine(null, 7, 1000, 1)]);

      expect(order.lines).toHaveLength(1);
      expect(order.lines[0].status).toBe(OrderLineStatusEnum.ALLOCATED);
    });
  });
});
