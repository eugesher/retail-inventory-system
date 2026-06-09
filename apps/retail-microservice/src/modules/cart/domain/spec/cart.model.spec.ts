import { CartStatusEnum } from '@retail-inventory-system/contracts';

import {
  Cart,
  CartCreatedEvent,
  CartDomainException,
  CartLine,
  CartLineAddedEvent,
  CartLineQuantityChangedEvent,
  CartLineRemovedEvent,
} from '..';

const makeLine = (
  id: number | null,
  variantId: number,
  unitPriceSnapshotMinor = 1000,
  quantity = 1,
): CartLine =>
  new CartLine({ id, variantId, quantity, unitPriceSnapshotMinor, currencySnapshot: 'USD' });

// Reconstitutes an active cart with concrete-id lines so the line-targeting
// mutators (`changeLineQuantity` / `removeLine`, which key on the BIGINT line id)
// have something to find — a freshly added line carries a null id until it is
// persisted and reloaded.
const makeActiveCartWithLines = (lines: CartLine[]): Cart =>
  Cart.reconstitute({
    id: '11111111-1111-1111-1111-111111111111',
    customerId: 'cust-1',
    currency: 'USD',
    status: CartStatusEnum.ACTIVE,
    lines,
    version: 5,
  });

describe('Cart', () => {
  describe('create', () => {
    it('yields an active cart at version 0 with a generated id and no lines', () => {
      const cart = Cart.create({ customerId: 'cust-1', currency: 'USD' });

      expect(cart.status).toBe(CartStatusEnum.ACTIVE);
      expect(cart.version).toBe(0);
      expect(cart.lines).toHaveLength(0);
      expect(cart.customerId).toBe('cust-1');
      expect(cart.currency).toBe('USD');
      expect(typeof cart.id).toBe('string');
      expect(cart.id).toMatch(/^[0-9a-f-]{36}$/);
    });

    it('records a CartCreatedEvent carrying the cart id, customer, and currency', () => {
      const cart = Cart.create({ customerId: null, currency: 'EUR' });

      const events = cart.pullDomainEvents();
      expect(events).toHaveLength(1);
      expect(events[0]).toBeInstanceOf(CartCreatedEvent);
      const event = events[0] as CartCreatedEvent;
      expect(event.cartId).toBe(cart.id);
      expect(event.customerId).toBeNull();
      expect(event.currency).toBe('EUR');
    });

    it('allows a null customerId (a guest cart)', () => {
      const cart = Cart.create({ customerId: null, currency: 'USD' });
      expect(cart.customerId).toBeNull();
    });

    it.each([
      ['empty', ''],
      ['too long', 'USDD'],
      ['too short', 'US'],
    ])('rejects a %s currency', (_label, currency) => {
      expect(() => Cart.create({ customerId: null, currency })).toThrow(CartDomainException);
    });
  });

  describe('currency immutability', () => {
    it('keeps currency fixed after create (getter-only, no setter)', () => {
      const cart = Cart.create({ customerId: null, currency: 'USD' });

      // The currency accessor has no setter, so assigning through it throws in
      // strict mode — and the value stays put regardless.
      expect(() => {
        (cart as unknown as { currency: string }).currency = 'EUR';
      }).toThrow();
      expect(cart.currency).toBe('USD');
    });
  });

  describe('addLine', () => {
    it('appends a new line, bumps the version, and records CartLineAddedEvent', () => {
      const cart = Cart.create({ customerId: 'cust-1', currency: 'USD' });
      cart.pullDomainEvents(); // drain the create event

      cart.addLine({
        variantId: 7,
        quantity: 2,
        unitPriceSnapshotMinor: 1500,
        currencySnapshot: 'USD',
      });

      expect(cart.lines).toHaveLength(1);
      expect(cart.lines[0].variantId).toBe(7);
      expect(cart.lines[0].quantity).toBe(2);
      expect(cart.version).toBe(1);

      const events = cart.pullDomainEvents();
      expect(events).toHaveLength(1);
      expect(events[0]).toBeInstanceOf(CartLineAddedEvent);
      const event = events[0] as CartLineAddedEvent;
      expect(event.variantId).toBe(7);
      expect(event.quantity).toBe(2);
    });

    it('increments an existing line for the same variant instead of duplicating it', () => {
      const cart = Cart.create({ customerId: 'cust-1', currency: 'USD' });
      cart.addLine({
        variantId: 7,
        quantity: 2,
        unitPriceSnapshotMinor: 1500,
        currencySnapshot: 'USD',
      });
      cart.addLine({
        variantId: 7,
        quantity: 3,
        unitPriceSnapshotMinor: 9999, // ignored — the original snapshot is preserved
        currencySnapshot: 'USD',
      });

      expect(cart.lines).toHaveLength(1);
      expect(cart.lines[0].quantity).toBe(5);
      expect(cart.lines[0].unitPriceSnapshotMinor).toBe(1500);
      expect(cart.version).toBe(2);
    });

    it('rejects adding to a non-active cart', () => {
      const cart = Cart.create({ customerId: 'cust-1', currency: 'USD' });
      cart.markConverted();

      expect(() =>
        cart.addLine({
          variantId: 7,
          quantity: 1,
          unitPriceSnapshotMinor: 1000,
          currencySnapshot: 'USD',
        }),
      ).toThrow(CartDomainException);
    });
  });

  describe('changeLineQuantity', () => {
    it('sets a new positive quantity, bumps the version, and records the event', () => {
      const cart = makeActiveCartWithLines([makeLine(100, 7)]);

      cart.changeLineQuantity(100, 4);

      expect(cart.lines[0].quantity).toBe(4);
      expect(cart.version).toBe(6);
      const events = cart.pullDomainEvents();
      expect(events).toHaveLength(1);
      expect(events[0]).toBeInstanceOf(CartLineQuantityChangedEvent);
      const event = events[0] as CartLineQuantityChangedEvent;
      expect(event.lineId).toBe(100);
      expect(event.quantity).toBe(4);
    });

    it('rejects a quantity of 0 (removal is the explicit op)', () => {
      const cart = makeActiveCartWithLines([makeLine(100, 7)]);
      expect(() => cart.changeLineQuantity(100, 0)).toThrow(CartDomainException);
    });

    it('rejects an unknown line id', () => {
      const cart = makeActiveCartWithLines([makeLine(100, 7)]);
      expect(() => cart.changeLineQuantity(999, 2)).toThrow(CartDomainException);
    });

    it('rejects a change on a non-active cart', () => {
      const cart = Cart.reconstitute({
        id: 'c1',
        customerId: 'cust-1',
        currency: 'USD',
        status: CartStatusEnum.CONVERTED,
        lines: [makeLine(100, 7)],
        version: 2,
      });
      expect(() => cart.changeLineQuantity(100, 2)).toThrow(CartDomainException);
    });
  });

  describe('removeLine', () => {
    it('drops the line, bumps the version, and records CartLineRemovedEvent', () => {
      const cart = makeActiveCartWithLines([makeLine(100, 7), makeLine(101, 8)]);

      cart.removeLine(100);

      expect(cart.lines).toHaveLength(1);
      expect(cart.lines[0].id).toBe(101);
      expect(cart.version).toBe(6);
      const events = cart.pullDomainEvents();
      expect(events).toHaveLength(1);
      expect(events[0]).toBeInstanceOf(CartLineRemovedEvent);
      expect((events[0] as CartLineRemovedEvent).lineId).toBe(100);
    });

    it('rejects removing an unknown line id', () => {
      const cart = makeActiveCartWithLines([makeLine(100, 7)]);
      expect(() => cart.removeLine(999)).toThrow(CartDomainException);
    });

    it('rejects a removal on a non-active cart', () => {
      const cart = Cart.reconstitute({
        id: 'c1',
        customerId: 'cust-1',
        currency: 'USD',
        status: CartStatusEnum.CONVERTED,
        lines: [makeLine(100, 7)],
        version: 2,
      });
      expect(() => cart.removeLine(100)).toThrow(CartDomainException);
    });
  });

  describe('total', () => {
    it('sums unitPriceSnapshotMinor times quantity across lines, carrying the cart currency', () => {
      const cart = makeActiveCartWithLines([
        makeLine(100, 7, 1500, 2), // 3000
        makeLine(101, 8, 999, 3), // 2997
      ]);

      expect(cart.total).toEqual({ subtotalMinor: 5997, currency: 'USD' });
    });

    it('keeps a line snapshot stable when a sibling line changes (mutate B, A unchanged)', () => {
      const cart = makeActiveCartWithLines([makeLine(100, 7, 1500, 2), makeLine(101, 8, 999, 1)]);

      cart.changeLineQuantity(101, 9);

      expect(cart.lines[0].unitPriceSnapshotMinor).toBe(1500);
      expect(cart.lines[0].quantity).toBe(2);
    });
  });

  describe('status transitions', () => {
    it('markConverted moves an active cart to converted and bumps the version', () => {
      const cart = Cart.create({ customerId: 'cust-1', currency: 'USD' });
      cart.markConverted();
      expect(cart.status).toBe(CartStatusEnum.CONVERTED);
      expect(cart.version).toBe(1);
    });

    it('markConverted rejects a non-active cart', () => {
      const cart = Cart.create({ customerId: 'cust-1', currency: 'USD' });
      cart.markConverted();
      expect(() => cart.markConverted()).toThrow(CartDomainException);
    });

    it('markAbandoned moves an active cart to abandoned', () => {
      const cart = Cart.create({ customerId: 'cust-1', currency: 'USD' });
      cart.markAbandoned();
      expect(cart.status).toBe(CartStatusEnum.ABANDONED);
    });

    it('markAbandoned rejects a non-active cart', () => {
      const cart = Cart.create({ customerId: 'cust-1', currency: 'USD' });
      cart.markConverted();
      expect(() => cart.markAbandoned()).toThrow(CartDomainException);
    });
  });

  describe('reconstitute', () => {
    it('rebuilds a cart at any status/version and records no events', () => {
      const cart = Cart.reconstitute({
        id: 'c1',
        customerId: null,
        currency: 'GBP',
        status: CartStatusEnum.ABANDONED,
        lines: [makeLine(100, 7)],
        version: 9,
      });

      expect(cart.status).toBe(CartStatusEnum.ABANDONED);
      expect(cart.version).toBe(9);
      expect(cart.pullDomainEvents()).toHaveLength(0);
    });

    it('rejects a negative version', () => {
      expect(() =>
        Cart.reconstitute({
          id: 'c1',
          customerId: null,
          currency: 'USD',
          version: -1,
        }),
      ).toThrow(CartDomainException);
    });
  });
});
