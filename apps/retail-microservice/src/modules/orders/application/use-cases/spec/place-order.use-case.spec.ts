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
import { makePinoLoggerMock } from '@retail-inventory-system/observability/testing';

import { OrderErrorCodeEnum } from '../../../domain';
import { IOrderCartSnapshot } from '../../ports';
import { AuthorizePaymentUseCase } from '../authorize-payment.use-case';
import { PlaceOrderUseCase } from '../place-order.use-case';
import {
  buildPrice,
  buildVariant,
  FakeAddressRepository,
  FakeCartReader,
  FakeCatalogGateway,
  FakeOrderRepository,
  FakePaymentGateway,
  FakePaymentRepository,
  FakeTransactionPort,
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
  orderRepository: FakeOrderRepository;
  addressRepository: FakeAddressRepository;
  paymentRepository: FakePaymentRepository;
  paymentGateway: FakePaymentGateway;
  publisher: SpyOrderEventsPublisher;
}

const makeHarness = (
  cart: IOrderCartSnapshot | null,
  catalog = catalogMaps(),
  approve = true,
): IHarness => {
  const logger = makePinoLoggerMock() as unknown as PinoLogger;
  const cartReader = new FakeCartReader(cart);
  const catalogGateway = new FakeCatalogGateway(catalog.variants, catalog.prices);
  const orderRepository = new FakeOrderRepository();
  const addressRepository = new FakeAddressRepository();
  const paymentRepository = new FakePaymentRepository();
  const paymentGateway = new FakePaymentGateway(approve);
  const transactionPort = new FakeTransactionPort();
  const publisher = new SpyOrderEventsPublisher();

  const authorize = new AuthorizePaymentUseCase(
    transactionPort,
    paymentGateway,
    paymentRepository,
    orderRepository,
    logger,
  );
  const useCase = new PlaceOrderUseCase(
    cartReader,
    catalogGateway,
    orderRepository,
    addressRepository,
    paymentRepository,
    transactionPort,
    publisher,
    authorize,
    logger,
  );

  return {
    useCase,
    cartReader,
    orderRepository,
    addressRepository,
    paymentRepository,
    paymentGateway,
    publisher,
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
