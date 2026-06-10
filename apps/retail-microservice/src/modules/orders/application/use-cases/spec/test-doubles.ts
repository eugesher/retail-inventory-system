import { PriceView, VariantWithProductView } from '@retail-inventory-system/contracts';

import { Address, Order, OrderLine, Payment } from '../../../domain';
import {
  IAddressRepositoryPort,
  IOrderCartReaderPort,
  IOrderCartSnapshot,
  IOrderCatalogGatewayPort,
  IOrderEventsPublisherPort,
  IOrderPage,
  IOrderPageRequest,
  IOrderRepositoryPort,
  IPaymentAuthorizeRequest,
  IPaymentAuthorizeResult,
  IPaymentCaptureResult,
  IPaymentGatewayPort,
  IPaymentRepositoryPort,
  ITransactionPort,
  ITransactionScope,
} from '../../ports';

// Jest-free so the production build (which excludes `*.spec.ts` but not
// `test-doubles.ts`) stays clean — the catalog/inventory/cart convention. Methods
// return `Promise.resolve(...)` rather than being `async`, so the no-floating /
// require-await lint rules stay satisfied.

// A throwaway brand value — the fakes ignore the scope (they share no real
// transaction), so any object satisfies the opaque `ITransactionScope` here.
export const FAKE_SCOPE = {} as unknown as ITransactionScope;

// Runs the work immediately with the throwaway scope — no real transaction. Good
// enough for the use-case unit tests, which assert orchestration, not atomicity.
export class FakeTransactionPort implements ITransactionPort {
  public runInTransaction<T>(work: (scope: ITransactionScope) => Promise<T>): Promise<T> {
    return work(FAKE_SCOPE);
  }
}

// A mutable cart snapshot the place use case reads. `markConverted` flips the
// in-memory status so a repeat place observes `converted` (the cart-state
// idempotency path).
export class FakeCartReader implements IOrderCartReaderPort {
  public convertedCount = 0;

  constructor(private snapshot: IOrderCartSnapshot | null) {}

  public findCart(cartId: string): Promise<IOrderCartSnapshot | null> {
    if (this.snapshot?.cartId !== cartId) {
      return Promise.resolve(null);
    }
    return Promise.resolve({
      ...this.snapshot,
      lines: this.snapshot.lines.map((line) => ({ ...line })),
    });
  }

  public markConverted(cartId: string): Promise<void> {
    if (this.snapshot?.cartId === cartId) {
      this.snapshot = { ...this.snapshot, status: 'converted' };
    }
    this.convertedCount += 1;
    return Promise.resolve();
  }
}

// Resolves variant headers + applicable prices from in-memory maps. A variant with
// no price entry (or an explicit `null`) drives the `ORDER_LINE_NO_PRICE` rejection.
export class FakeCatalogGateway implements IOrderCatalogGatewayPort {
  constructor(
    private readonly variants: Map<number, VariantWithProductView>,
    private readonly prices: Map<number, PriceView | null>,
  ) {}

  public getVariant(variantId: number): Promise<VariantWithProductView> {
    const variant = this.variants.get(variantId);
    if (!variant) {
      return Promise.reject(new Error(`FakeCatalogGateway: variant ${variantId} not found`));
    }
    return Promise.resolve(variant);
  }

  public selectApplicablePrice(variantId: number): Promise<PriceView | null> {
    return Promise.resolve(this.prices.get(variantId) ?? null);
  }
}

// An in-memory order store that assigns BIGINT ids, derives `order_number` from the
// id on first insert, tracks the attached snapshot-address ids, and re-reads the
// merged state — enough to exercise the place + authorize orchestration.
export class FakeOrderRepository implements IOrderRepositoryPort {
  public saveCount = 0;
  private seq = 0;
  private readonly byId = new Map<number, Order>();
  private readonly addresses = new Map<number, { billing: string; shipping: string }>();

  public findById(id: number): Promise<Order | null> {
    const order = this.byId.get(id);
    return Promise.resolve(order ? this.materialize(order, id) : null);
  }

  public findBySourceCartId(cartId: string): Promise<Order | null> {
    for (const [id, order] of this.byId.entries()) {
      if (order.sourceCartId === cartId) {
        return Promise.resolve(this.materialize(order, id));
      }
    }
    return Promise.resolve(null);
  }

  public save(order: Order): Promise<Order> {
    this.saveCount += 1;
    const id = order.id ?? ++this.seq;
    const orderNumber =
      order.id === null ? `ORD-2026-${String(id).padStart(8, '0')}` : order.orderNumber;
    const stored = this.rebuild(order, id, orderNumber);
    this.byId.set(id, stored);
    return Promise.resolve(this.materialize(stored, id));
  }

  public attachAddresses(
    orderId: number,
    billingAddressId: string,
    shippingAddressId: string,
  ): Promise<void> {
    this.addresses.set(orderId, { billing: billingAddressId, shipping: shippingAddressId });
    return Promise.resolve();
  }

  public listByCustomer(customerId: string, page: IOrderPageRequest): Promise<IOrderPage> {
    const items = [...this.byId.values()].filter((order) => order.customerId === customerId);
    return Promise.resolve({ items, total: items.length, page: page.page, size: page.size });
  }

  public nextOrderNumber(): Promise<string> {
    return Promise.resolve(`ORD-2026-${String(this.seq + 1).padStart(8, '0')}`);
  }

  // Reconstitutes an order with the stored billing/shipping ids folded back in, so a
  // post-`attachAddresses` read carries the snapshot-address pointers (as the real
  // repo's re-read does).
  private materialize(order: Order, id: number): Order {
    const addr = this.addresses.get(id);
    return this.rebuild(order, id, order.orderNumber, addr?.billing, addr?.shipping);
  }

  private rebuild(
    order: Order,
    id: number,
    orderNumber: string,
    billingAddressId?: string,
    shippingAddressId?: string,
  ): Order {
    return Order.reconstitute({
      id,
      orderNumber,
      customerId: order.customerId,
      currency: order.currency,
      status: order.status,
      paymentStatus: order.paymentStatus,
      fulfillmentStatus: order.fulfillmentStatus,
      lines: [...order.lines] as OrderLine[],
      subtotalMinor: order.subtotalMinor,
      taxTotalMinor: order.taxTotalMinor,
      discountTotalMinor: order.discountTotalMinor,
      shippingTotalMinor: order.shippingTotalMinor,
      grandTotalMinor: order.grandTotalMinor,
      billingAddressId: billingAddressId ?? order.billingAddressId,
      shippingAddressId: shippingAddressId ?? order.shippingAddressId,
      sourceCartId: order.sourceCartId,
      placedAt: order.placedAt,
      version: order.version,
    });
  }
}

// In-memory address store keyed by the caller-assigned UUID.
export class FakeAddressRepository implements IAddressRepositoryPort {
  public readonly saved: Address[] = [];
  private readonly byId = new Map<string, Address>();

  public save(address: Address): Promise<Address> {
    this.saved.push(address);
    this.byId.set(address.id!, address);
    return Promise.resolve(address);
  }

  public findById(id: string): Promise<Address | null> {
    return Promise.resolve(this.byId.get(id) ?? null);
  }

  public findByOwner(): Promise<Address[]> {
    return Promise.resolve([...this.byId.values()]);
  }
}

// In-memory payment store that assigns BIGINT ids and resolves the single payment
// per order.
export class FakePaymentRepository implements IPaymentRepositoryPort {
  public saveCount = 0;
  private seq = 0;
  private readonly byId = new Map<number, Payment>();

  public save(payment: Payment): Promise<Payment> {
    this.saveCount += 1;
    const id = payment.id ?? ++this.seq;
    const stored = this.rebuild(payment, id);
    this.byId.set(id, stored);
    return Promise.resolve(stored);
  }

  public findById(id: number): Promise<Payment | null> {
    return Promise.resolve(this.byId.get(id) ?? null);
  }

  public findByOrderId(orderId: number): Promise<Payment | null> {
    let latest: Payment | null = null;
    for (const payment of this.byId.values()) {
      if (payment.orderId === orderId) {
        latest = payment;
      }
    }
    return Promise.resolve(latest);
  }

  private rebuild(payment: Payment, id: number): Payment {
    return Payment.reconstitute({
      id,
      orderId: payment.orderId,
      amountMinor: payment.amountMinor,
      currency: payment.currency,
      method: payment.method,
      status: payment.status,
      gatewayReference: payment.gatewayReference,
      authorizedAt: payment.authorizedAt,
      capturedAt: payment.capturedAt,
    });
  }
}

// A configurable payment gateway fake — approves or declines, minting a distinct
// `gatewayReference` per authorize (the UNIQUE column relies on it).
export class FakePaymentGateway implements IPaymentGatewayPort {
  public authorizeCount = 0;
  private seq = 0;

  constructor(private readonly approve = true) {}

  public authorize(req: IPaymentAuthorizeRequest): Promise<IPaymentAuthorizeResult> {
    this.authorizeCount += 1;
    return Promise.resolve({
      approved: this.approve,
      gatewayReference: `fake_${++this.seq}`,
      method: req.method ?? 'fake-card',
      authorizedAt: new Date('2026-06-10T00:00:00.000Z'),
    });
  }

  public capture(gatewayReference: string): Promise<IPaymentCaptureResult> {
    return Promise.resolve({
      captured: true,
      gatewayReference,
      capturedAt: new Date('2026-06-10T00:00:00.000Z'),
    });
  }
}

// Records the published wire events so a spec can assert both fired.
export class SpyOrderEventsPublisher implements IOrderEventsPublisherPort {
  public readonly placed: unknown[] = [];
  public readonly authorized: unknown[] = [];

  public publishOrderPlaced(event: unknown): Promise<void> {
    this.placed.push(event);
    return Promise.resolve();
  }

  public publishPaymentAuthorized(event: unknown): Promise<void> {
    this.authorized.push(event);
    return Promise.resolve();
  }
}

// A `VariantWithProductView` fixture builder for the snapshot assertions.
export const buildVariant = (
  variantId: number,
  sku: string,
  productName: string,
  optionValues: Record<string, string> = {},
): VariantWithProductView => ({
  id: variantId,
  productId: 1,
  sku,
  gtin: null,
  optionValues,
  weightG: null,
  dimensionsMm: null,
  status: 'active',
  product: {
    id: 1,
    name: productName,
    slug: productName.toLowerCase().replace(/\s+/g, '-'),
    description: '',
    status: 'active',
  },
});

// A `PriceView` fixture builder.
export const buildPrice = (
  variantId: number,
  amountMinor: number,
  currency = 'USD',
): PriceView => ({
  id: variantId,
  variantId,
  currency,
  amountMinor,
  validFrom: '2020-01-01T00:00:00.000Z',
  validTo: null,
  priority: 0,
});
