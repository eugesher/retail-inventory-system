import { PinoLogger } from 'nestjs-pino';

import {
  CartStatusEnum,
  IAddressInput,
  IPlaceOrderPayload,
  OrderFulfillmentStatusEnum,
  OrderPaymentStatusEnum,
  OrderStatusEnum,
  PriceView,
  VariantWithProductView,
} from '@retail-inventory-system/contracts';
import { makePinoLoggerMock, PinoLoggerMock } from '@retail-inventory-system/observability/testing';

import { OrderErrorCodeEnum } from '../../../domain';
import { IOrderCartSnapshot, ITransactionPort } from '../../ports';
import { AuthorizePaymentUseCase } from '../authorize-payment.use-case';
import { PlaceOrderUseCase } from '../place-order.use-case';
import {
  buildPrice,
  buildVariant,
  CommitFailingTransactionPort,
  FakeAddressRepository,
  FakeCartReader,
  FakeCatalogGateway,
  FakeOrderInventoryGateway,
  FakeOrderRepository,
  FakePaymentGateway,
  FakePaymentRepository,
  FakeTransactionPort,
  makeWireError,
  SpyOrderEventsPublisher,
} from './test-doubles';

const CUSTOMER_ID = '00000000-0000-4000-a000-000000000002';
const OTHER_CUSTOMER_ID = '00000000-0000-4000-a000-000000000099';

const ADDRESS: IAddressInput = {
  recipientName: 'Jane Buyer',
  line1: '1 Market St',
  city: 'San Francisco',
  region: 'CA',
  postalCode: '94105',
  country: 'US',
};

const activeCart = (overrides: Partial<IOrderCartSnapshot> = {}): IOrderCartSnapshot => ({
  cartId: 'cart-1',
  customerId: CUSTOMER_ID,
  currency: 'USD',
  status: CartStatusEnum.ACTIVE,
  lines: [
    { variantId: 1, quantity: 2 },
    { variantId: 3, quantity: 1 },
  ],
  ...overrides,
});

const catalogMaps = (): {
  variants: Map<number, VariantWithProductView>;
  prices: Map<number, PriceView | null>;
} => ({
  variants: new Map([
    [1, buildVariant(1, 'AURORA-WARM', 'Aurora Desk Lamp', { color: 'warm-white' })],
    [3, buildVariant(3, 'NIMBUS-BLACK', 'Nimbus Office Chair', { color: 'black' })],
  ]),
  prices: new Map<number, PriceView | null>([
    [1, buildPrice(1, 4999)],
    [3, buildPrice(3, 19999)],
  ]),
});

interface IHarness {
  useCase: PlaceOrderUseCase;
  cartReader: FakeCartReader;
  inventory: FakeOrderInventoryGateway;
  orderRepository: FakeOrderRepository;
  addressRepository: FakeAddressRepository;
  paymentRepository: FakePaymentRepository;
  paymentGateway: FakePaymentGateway;
  publisher: SpyOrderEventsPublisher;
  logger: PinoLoggerMock;
}

const makeHarness = (
  cart: IOrderCartSnapshot | null,
  catalog = catalogMaps(),
  approve = true,
  transactionPort: ITransactionPort = new FakeTransactionPort(),
): IHarness => {
  const logger = makePinoLoggerMock();
  const typedLogger = logger as unknown as PinoLogger;
  const cartReader = new FakeCartReader(cart);
  const catalogGateway = new FakeCatalogGateway(catalog.variants, catalog.prices);
  const inventory = new FakeOrderInventoryGateway();
  const orderRepository = new FakeOrderRepository();
  const addressRepository = new FakeAddressRepository();
  const paymentRepository = new FakePaymentRepository();
  const paymentGateway = new FakePaymentGateway(approve);
  const publisher = new SpyOrderEventsPublisher();

  const authorize = new AuthorizePaymentUseCase(
    transactionPort,
    paymentGateway,
    paymentRepository,
    orderRepository,
    typedLogger,
  );
  const useCase = new PlaceOrderUseCase(
    cartReader,
    catalogGateway,
    inventory,
    orderRepository,
    addressRepository,
    paymentRepository,
    transactionPort,
    publisher,
    authorize,
    typedLogger,
  );

  return {
    useCase,
    cartReader,
    inventory,
    orderRepository,
    addressRepository,
    paymentRepository,
    paymentGateway,
    publisher,
    logger,
  };
};

const placePayload = (overrides: Partial<IPlaceOrderPayload> = {}): IPlaceOrderPayload => ({
  cartId: 'cart-1',
  customerId: CUSTOMER_ID,
  shippingAddress: ADDRESS,
  billingAddress: ADDRESS,
  paymentMethod: 'tok_visa',
  idempotencyKey: 'idem-1',
  correlationId: 'corr-1',
  ...overrides,
});

describe('PlaceOrderUseCase', () => {
  describe('happy path', () => {
    it('snapshots lines from the catalog, places a pending order, and authorizes payment', async () => {
      const h = makeHarness(activeCart());

      const view = await h.useCase.execute(placePayload());

      // Order header: pending lifecycle, authorized payment, unfulfilled fulfillment
      // — the three orthogonal axes (ADR-028 §2).
      expect(view.id).toEqual(expect.any(Number));
      expect(view.orderNumber).toMatch(/^ORD-\d{4}-\d{8}$/);
      expect(view.status).toBe(OrderStatusEnum.PENDING);
      expect(view.paymentStatus).toBe(OrderPaymentStatusEnum.AUTHORIZED);
      expect(view.fulfillmentStatus).toBe(OrderFulfillmentStatusEnum.UNFULFILLED);

      // Totals: grandTotal = subtotal = Σ unitPrice×qty; tax/discount/shipping 0.
      expect(view.subtotalMinor).toBe(4999 * 2 + 19999);
      expect(view.grandTotalMinor).toBe(29997);
      expect(view.taxTotalMinor).toBe(0);
      expect(view.discountTotalMinor).toBe(0);
      expect(view.shippingTotalMinor).toBe(0);

      // Line snapshots: sku + composed nameSnapshot + unitPriceMinor from the catalog.
      expect(view.lines).toHaveLength(2);
      expect(view.lines[0]).toMatchObject({
        variantId: 1,
        sku: 'AURORA-WARM',
        nameSnapshot: 'Aurora Desk Lamp (color: warm-white)',
        quantity: 2,
        unitPriceMinor: 4999,
        lineTotalMinor: 9998,
      });
      expect(view.lines[1]).toMatchObject({
        variantId: 3,
        sku: 'NIMBUS-BLACK',
        nameSnapshot: 'Nimbus Office Chair (color: black)',
        quantity: 1,
        unitPriceMinor: 19999,
        lineTotalMinor: 19999,
      });

      // Two snapshot addresses written; the order points at them.
      expect(h.addressRepository.saved).toHaveLength(2);
      expect(view.billingAddressId).toEqual(expect.any(String));
      expect(view.shippingAddressId).toEqual(expect.any(String));
      expect(view.billingAddressId).not.toBe(view.shippingAddressId);

      // Cart marked converted; payment present.
      expect(h.cartReader.convertedCount).toBe(1);
      expect(view.payment).toBeDefined();
      expect(view.payment?.amountMinor).toBe(29997);
      expect(view.payment?.status).toBe('authorized');

      // Both wire events emitted.
      expect(h.publisher.placed).toHaveLength(1);
      expect(h.publisher.authorized).toHaveLength(1);
      expect(h.publisher.placed[0]).toMatchObject({
        orderNumber: view.orderNumber,
        grandTotalMinor: 29997,
        lineCount: 2,
        eventVersion: 'v1',
      });
      expect(h.publisher.authorized[0]).toMatchObject({
        orderId: view.id,
        amountMinor: 29997,
        eventVersion: 'v1',
      });

      // The cart's holds were allocated to the order, carrying the orderId + the
      // snapshotted lines (the lines ride the payload so inventory's fallback needs
      // no cross-service read).
      expect(h.inventory.allocateCalls).toHaveLength(1);
      expect(h.inventory.allocateCalls[0]).toEqual({
        cartId: 'cart-1',
        orderId: view.id,
        lines: [
          { variantId: 1, quantity: 2 },
          { variantId: 3, quantity: 1 },
        ],
        correlationId: 'corr-1',
      });
      // The happy path never compensates.
      expect(h.inventory.cancelCalls).toHaveLength(0);
    });

    it('allocates AFTER the cart-conversion CAS and BEFORE payment authorization', async () => {
      const h = makeHarness(activeCart());
      const convertSpy = jest.spyOn(h.cartReader, 'markConverted');
      const allocateSpy = jest.spyOn(h.inventory, 'allocateStock');
      const authorizeSpy = jest.spyOn(h.paymentGateway, 'authorize');

      await h.useCase.execute(placePayload());

      // markConverted (the CAS) precedes allocate, which precedes payment authorize
      // — so money is never authorized for stock that could not be allocated.
      expect(convertSpy.mock.invocationCallOrder[0]).toBeLessThan(
        allocateSpy.mock.invocationCallOrder[0],
      );
      expect(allocateSpy.mock.invocationCallOrder[0]).toBeLessThan(
        authorizeSpy.mock.invocationCallOrder[0],
      );
    });
  });

  describe('allocation', () => {
    it('an allocate rejection propagates, with no payment authorization and no events', async () => {
      const h = makeHarness(activeCart());
      h.inventory.allocateError = makeWireError('INVENTORY_OUT_OF_STOCK', 409, 'Out of stock', {
        available: 0,
      });

      await expect(h.useCase.execute(placePayload())).rejects.toMatchObject({
        code: 'INVENTORY_OUT_OF_STOCK',
        details: { available: 0 },
      });

      // No payment authorized, no events emitted, and no compensation (the allocate
      // never committed inventory-side, so there is nothing to unwind).
      expect(h.paymentGateway.authorizeCount).toBe(0);
      expect(h.publisher.placed).toHaveLength(0);
      expect(h.publisher.authorized).toHaveLength(0);
      expect(h.inventory.cancelCalls).toHaveLength(0);
    });

    it('does not allocate when the cart-conversion CAS loses (concurrent place)', async () => {
      const h = makeHarness(activeCart());
      // The cart passes the up-front guard (active at findCart) but the CAS flips no
      // row — a concurrent place converted it first.
      jest.spyOn(h.cartReader, 'markConverted').mockResolvedValue(false);

      await expect(h.useCase.execute(placePayload())).rejects.toMatchObject({
        code: OrderErrorCodeEnum.ORDER_CART_NOT_PLACEABLE,
      });

      // Allocate-after-CAS means the loser never allocates — no double allocation.
      expect(h.inventory.allocateCalls).toHaveLength(0);
      expect(h.paymentGateway.authorizeCount).toBe(0);
    });

    it('compensates with cancelAllocation when the place commit fails after allocate', async () => {
      const commitError = new Error('commit failed');
      const h = makeHarness(
        activeCart(),
        catalogMaps(),
        true,
        new CommitFailingTransactionPort(commitError),
      );

      await expect(h.useCase.execute(placePayload())).rejects.toBe(commitError);

      // The allocation committed inventory-side, then the place tx failed at commit
      // → the orphaned allocation is cancelled best-effort with reason place-rollback.
      expect(h.inventory.allocateCalls).toHaveLength(1);
      expect(h.inventory.cancelCalls).toHaveLength(1);
      expect(h.inventory.cancelCalls[0]).toMatchObject({
        lines: [
          { variantId: 1, quantity: 2 },
          { variantId: 3, quantity: 1 },
        ],
        reason: 'place-rollback',
        correlationId: 'corr-1',
      });
      expect(h.inventory.cancelCalls[0].orderId).toEqual(expect.any(Number));
      // The original commit error still surfaced; no payment, no events.
      expect(h.paymentGateway.authorizeCount).toBe(0);
      expect(h.publisher.placed).toHaveLength(0);
    });

    it('swallows a failed compensation and still rethrows the original commit error', async () => {
      const commitError = new Error('commit failed');
      const h = makeHarness(
        activeCart(),
        catalogMaps(),
        true,
        new CommitFailingTransactionPort(commitError),
      );
      h.inventory.cancelError = new Error('inventory unreachable');

      await expect(h.useCase.execute(placePayload())).rejects.toBe(commitError);

      expect(h.inventory.cancelCalls).toHaveLength(1);
      // The failed compensation was warn-logged, not raised over the commit error.
      expect(h.logger.warn).toHaveBeenCalled();
    });

    it('does not re-allocate on a repeat place (cart already converted)', async () => {
      const h = makeHarness(activeCart());

      await h.useCase.execute(placePayload());
      expect(h.inventory.allocateCalls).toHaveLength(1);

      // The cart is now converted; a repeat place resolves the existing order and
      // never allocates again.
      await h.useCase.execute(placePayload({ idempotencyKey: 'idem-2' }));
      expect(h.inventory.allocateCalls).toHaveLength(1);
    });
  });

  describe('rejections', () => {
    it('rejects an empty cart with ORDER_CART_EMPTY (409)', async () => {
      const h = makeHarness(activeCart({ lines: [] }));
      await expect(h.useCase.execute(placePayload())).rejects.toMatchObject({
        code: OrderErrorCodeEnum.ORDER_CART_EMPTY,
      });
    });

    it('rejects an abandoned cart with ORDER_CART_NOT_PLACEABLE (409)', async () => {
      const h = makeHarness(activeCart({ status: CartStatusEnum.ABANDONED }));
      await expect(h.useCase.execute(placePayload())).rejects.toMatchObject({
        code: OrderErrorCodeEnum.ORDER_CART_NOT_PLACEABLE,
      });
    });

    it('rejects a non-owner with ORDER_CART_ACCESS_FORBIDDEN (403)', async () => {
      const h = makeHarness(activeCart({ customerId: OTHER_CUSTOMER_ID }));
      await expect(h.useCase.execute(placePayload())).rejects.toMatchObject({
        code: OrderErrorCodeEnum.ORDER_CART_ACCESS_FORBIDDEN,
      });
    });

    it('rejects a missing cart with ORDER_CART_NOT_FOUND (404)', async () => {
      const h = makeHarness(null);
      await expect(h.useCase.execute(placePayload())).rejects.toMatchObject({
        code: OrderErrorCodeEnum.ORDER_CART_NOT_FOUND,
      });
    });

    it('rejects a line with no applicable price with ORDER_LINE_NO_PRICE (409)', async () => {
      const catalog = catalogMaps();
      catalog.prices.set(3, null); // variant 3 has no applicable price
      const h = makeHarness(activeCart(), catalog);
      await expect(h.useCase.execute(placePayload())).rejects.toMatchObject({
        code: OrderErrorCodeEnum.ORDER_LINE_NO_PRICE,
      });
      // No order is created when a line cannot be priced (the reject precedes persist).
      expect(h.orderRepository.saveCount).toBe(0);
    });
  });

  describe('cart-state idempotency (Q10)', () => {
    it('returns the same order on a repeat place and does not create a duplicate', async () => {
      const h = makeHarness(activeCart());

      const first = await h.useCase.execute(placePayload());
      const saveCountAfterFirst = h.orderRepository.saveCount;

      // The cart is now converted; a repeat place resolves the existing order.
      const second = await h.useCase.execute(placePayload({ idempotencyKey: 'idem-2' }));

      expect(second.id).toBe(first.id);
      expect(second.orderNumber).toBe(first.orderNumber);
      // No further order writes happened on the repeat (no duplicate order).
      expect(h.orderRepository.saveCount).toBe(saveCountAfterFirst);
      // The repeat path does not re-authorize or re-convert.
      expect(h.cartReader.convertedCount).toBe(1);
      expect(h.paymentGateway.authorizeCount).toBe(1);
      expect(second.payment).toBeDefined();
    });
  });
});
