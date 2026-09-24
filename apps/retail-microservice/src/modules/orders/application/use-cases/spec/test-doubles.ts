import {
  CartStatusEnum,
  IAllocationCancelPayload,
  IAllocationResult,
  IAuditLogEvent,
  IAuditLogPublisher,
  ICommitSalePayload,
  ICommitSaleResult,
  IReservationAllocatePayload,
  OrderFulfillmentStatusEnum,
  OrderLineStatusEnum,
  OrderPaymentStatusEnum,
  OrderStatusEnum,
  PaymentStatusEnum,
  PriceView,
  RefundStatusEnum,
  VariantWithProductView,
} from '@retail-inventory-system/contracts';

import {
  Address,
  Fulfillment,
  FulfillmentLine,
  Order,
  OrderLine,
  Payment,
  Refund,
} from '../../../domain';
import {
  IAddressRepositoryPort,
  IFulfillmentRepositoryPort,
  IIdempotencyFinalizeInput,
  IIdempotencyRecord,
  IIdempotencyRecordInput,
  IIdempotencyReservation,
  IIdempotencyReserveInput,
  IIdempotencyStorePort,
  IOrderCartReaderPort,
  IOrderCartSnapshot,
  IOrderCatalogGatewayPort,
  IOrderCommitSaleGatewayPort,
  IOrderCustomerContact,
  IOrderCustomerContactReaderPort,
  IOrderEventsPublisherPort,
  IOrderInventoryGatewayPort,
  IOrderPage,
  IOrderPageRequest,
  IOrderRepositoryPort,
  IPaymentAuthorizeRequest,
  IPaymentAuthorizeResult,
  IPaymentCaptureResult,
  IPaymentGatewayPort,
  IPaymentRefundRequest,
  IPaymentRefundResult,
  IPaymentRepositoryPort,
  IRefundRepositoryPort,
  ITransactionPort,
  ITransactionScope,
} from '../../ports';
import { OrderWriteConflictError } from '../order-write-conflict.error';

export const FAKE_SCOPE = {} as unknown as ITransactionScope;

export class FakeTransactionPort implements ITransactionPort {
  public runInTransaction<T>(work: (scope: ITransactionScope) => Promise<T>): Promise<T> {
    return work(FAKE_SCOPE);
  }
}

export class CommitFailingTransactionPort implements ITransactionPort {
  constructor(private readonly error: Error) {}

  public async runInTransaction<T>(work: (scope: ITransactionScope) => Promise<T>): Promise<T> {
    await work(FAKE_SCOPE);
    throw this.error;
  }
}

export interface ISnapshotableFake {
  snapshot(): () => void;
}

export class RollbackFakeTransactionPort implements ITransactionPort {
  constructor(private readonly fakes: ISnapshotableFake[]) {}

  public async runInTransaction<T>(work: (scope: ITransactionScope) => Promise<T>): Promise<T> {
    const restores = this.fakes.map((fake) => fake.snapshot());
    try {
      return await work(FAKE_SCOPE);
    } catch (error) {
      for (const restore of restores) {
        restore();
      }
      throw error;
    }
  }
}

export const makeWireError = (
  code: string,
  statusCode: number,
  message: string,
  details?: Record<string, unknown>,
): Error =>
  Object.assign(new Error(message), { statusCode, code, ...(details ? { details } : {}) });

export class FakeOrderInventoryGateway implements IOrderInventoryGatewayPort {
  public readonly allocateCalls: IReservationAllocatePayload[] = [];
  public readonly cancelCalls: IAllocationCancelPayload[] = [];
  public allocateError: Error | null = null;
  public cancelError: Error | null = null;

  public allocateStock(payload: IReservationAllocatePayload): Promise<IAllocationResult> {
    this.allocateCalls.push(payload);
    if (this.allocateError !== null) {
      return Promise.reject(this.allocateError);
    }
    return Promise.resolve({
      allocated: payload.lines.map((line) => ({
        variantId: line.variantId,
        stockLocationId: line.stockLocationId ?? 'default-warehouse',
        quantity: line.quantity,
        reservationId: `res-${line.variantId}`,
      })),
    });
  }

  public cancelAllocation(payload: IAllocationCancelPayload): Promise<void> {
    this.cancelCalls.push(payload);
    if (this.cancelError !== null) {
      return Promise.reject(this.cancelError);
    }
    return Promise.resolve();
  }
}

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

  public markConverted(cartId: string): Promise<boolean> {
    if (this.snapshot?.cartId === cartId && this.snapshot.status === CartStatusEnum.ACTIVE) {
      this.snapshot = { ...this.snapshot, status: CartStatusEnum.CONVERTED };
      this.convertedCount += 1;
      return Promise.resolve(true);
    }
    return Promise.resolve(false);
  }
}

export const FAKE_CUSTOMER_EMAIL = 'buyer@example.com';

export class FakeCustomerContactReader implements IOrderCustomerContactReaderPort {
  public readonly calls: string[] = [];

  constructor(
    private readonly email: string | null = FAKE_CUSTOMER_EMAIL,
    private readonly found = true,
  ) {}

  public findContactByCustomerId(customerId: string): Promise<IOrderCustomerContact | null> {
    this.calls.push(customerId);
    return Promise.resolve(this.found ? { email: this.email } : null);
  }
}

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

export class FakeOrderRepository implements IOrderRepositoryPort {
  public saveCount = 0;
  public conflictsBeforeSuccess = 0;
  private seq = 0;
  private readonly byId = new Map<number, Order>();
  private readonly addresses = new Map<number, { billing: string; shipping: string }>();

  public snapshot(): () => void {
    const copy = new Map(this.byId);
    const addrCopy = new Map(this.addresses);
    return (): void => {
      this.byId.clear();
      for (const [k, v] of copy) this.byId.set(k, v);
      this.addresses.clear();
      for (const [k, v] of addrCopy) this.addresses.set(k, v);
    };
  }

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

  public save(order: Order, _scope?: ITransactionScope, expectedVersion?: number): Promise<Order> {
    this.saveCount += 1;
    if (expectedVersion !== undefined && this.conflictsBeforeSuccess > 0) {
      this.conflictsBeforeSuccess -= 1;
      const current = this.byId.get(order.id!);
      return Promise.reject(
        new OrderWriteConflictError(order.id!, current ? current.version : expectedVersion),
      );
    }
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
    const all = [...this.byId.values()]
      .filter((order) => order.customerId === customerId)
      .sort((a, b) => {
        const byPlaced = (b.placedAt?.getTime() ?? 0) - (a.placedAt?.getTime() ?? 0);
        return byPlaced !== 0 ? byPlaced : (b.id ?? 0) - (a.id ?? 0);
      });
    const start = (page.page - 1) * page.size;
    const items = all.slice(start, start + page.size);
    return Promise.resolve({ items, total: all.length, page: page.page, size: page.size });
  }

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
      lines: order.lines.map(
        (line) =>
          new OrderLine({
            id: line.id,
            variantId: line.variantId,
            sku: line.sku,
            nameSnapshot: line.nameSnapshot,
            quantity: line.quantity,
            cancelledQuantity: line.cancelledQuantity,
            unitPriceMinor: line.unitPriceMinor,
            taxAmountMinor: line.taxAmountMinor,
            discountAmountMinor: line.discountAmountMinor,
            lineTotalMinor: line.lineTotalMinor,
            status: line.status,
          }),
      ),
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

export class FakeAddressRepository implements IAddressRepositoryPort {
  public readonly saved: Address[] = [];
  private readonly byId = new Map<string, Address>();

  public save(address: Address): Promise<Address> {
    this.saved.push(address);
    this.byId.set(address.id!, address);
    return Promise.resolve(address);
  }
}

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

  public snapshot(): () => void {
    const copy = new Map(this.byId);
    return (): void => {
      this.byId.clear();
      for (const [k, v] of copy) this.byId.set(k, v);
    };
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

  public findByOrderIdForUpdate(orderId: number): Promise<Payment | null> {
    return this.findByOrderId(orderId);
  }

  public listStaleCaptureClaims(olderThan: Date): Promise<Payment[]> {
    const stale = [...this.byId.values()].filter(
      (payment) =>
        payment.status === PaymentStatusEnum.CAPTURING &&
        payment.updatedAt !== null &&
        payment.updatedAt < olderThan,
    );
    return Promise.resolve(stale);
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
      flaggedForRefund: payment.flaggedForRefund,
      refundedAmountMinor: payment.refundedAmountMinor,
      updatedAt: payment.updatedAt,
    });
  }
}

export class FakePaymentGateway implements IPaymentGatewayPort {
  public authorizeCount = 0;
  public captureCount = 0;
  public refundCount = 0;
  public readonly refundCalls: IPaymentRefundRequest[] = [];
  private seq = 0;
  private refundSeq = 0;

  constructor(
    private readonly approve = true,
    private readonly captureOk = true,
    private readonly refundOk = true,
  ) {}

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
    this.captureCount += 1;
    return Promise.resolve({
      captured: this.captureOk,
      gatewayReference,
      capturedAt: new Date('2026-06-10T00:00:00.000Z'),
    });
  }

  public refund(req: IPaymentRefundRequest): Promise<IPaymentRefundResult> {
    this.refundCount += 1;
    this.refundCalls.push(req);
    return Promise.resolve({
      refunded: this.refundOk,
      gatewayReference: `fake_refund_${++this.refundSeq}`,
      refundedAt: new Date('2026-06-12T00:00:00.000Z'),
    });
  }
}

export class SpyOrderEventsPublisher implements IOrderEventsPublisherPort {
  public readonly placed: unknown[] = [];
  public readonly authorized: unknown[] = [];
  public readonly captured: unknown[] = [];
  public readonly fulfillmentCreated: unknown[] = [];
  public readonly fulfillmentShipped: unknown[] = [];
  public readonly fulfillmentDelivered: unknown[] = [];
  public readonly orderCancelled: unknown[] = [];
  public readonly refundIssued: unknown[] = [];
  public readonly refundFailed: unknown[] = [];

  public publishOrderPlaced(event: unknown): Promise<void> {
    this.placed.push(event);
    return Promise.resolve();
  }

  public publishPaymentAuthorized(event: unknown): Promise<void> {
    this.authorized.push(event);
    return Promise.resolve();
  }

  public publishPaymentCaptured(event: unknown): Promise<void> {
    this.captured.push(event);
    return Promise.resolve();
  }

  public publishFulfillmentCreated(event: unknown): Promise<void> {
    this.fulfillmentCreated.push(event);
    return Promise.resolve();
  }

  public publishFulfillmentShipped(event: unknown): Promise<void> {
    this.fulfillmentShipped.push(event);
    return Promise.resolve();
  }

  public publishFulfillmentDelivered(event: unknown): Promise<void> {
    this.fulfillmentDelivered.push(event);
    return Promise.resolve();
  }

  public publishOrderCancelled(event: unknown): Promise<void> {
    this.orderCancelled.push(event);
    return Promise.resolve();
  }

  public publishRefundIssued(event: unknown): Promise<void> {
    this.refundIssued.push(event);
    return Promise.resolve();
  }

  public publishRefundFailed(event: unknown): Promise<void> {
    this.refundFailed.push(event);
    return Promise.resolve();
  }
}

export class SpyAuditLogPublisher implements IAuditLogPublisher {
  public readonly events: IAuditLogEvent[] = [];

  public publish(event: IAuditLogEvent): Promise<void> {
    this.events.push(event);
    return Promise.resolve();
  }
}

export class FakeRefundRepository implements IRefundRepositoryPort {
  public saveCount = 0;
  private seq = 0;
  private readonly byId = new Map<number, Refund>();

  public save(refund: Refund): Promise<Refund> {
    this.saveCount += 1;
    const id = refund.id ?? ++this.seq;
    const stored = this.rebuild(refund, id);
    this.byId.set(id, stored);
    return Promise.resolve(this.rebuild(stored, id));
  }

  public findByOrderId(orderId: number): Promise<Refund[]> {
    return Promise.resolve(this.sortedNewestFirst((refund) => refund.orderId === orderId));
  }

  public findByPaymentId(paymentId: number): Promise<Refund[]> {
    return Promise.resolve(this.sortedNewestFirst((refund) => refund.paymentId === paymentId));
  }

  private sortedNewestFirst(predicate: (refund: Refund) => boolean): Refund[] {
    return [...this.byId.values()]
      .filter(predicate)
      .sort((a, b) => {
        const byIssued = (b.issuedAt?.getTime() ?? 0) - (a.issuedAt?.getTime() ?? 0);
        return byIssued !== 0 ? byIssued : (b.id ?? 0) - (a.id ?? 0);
      })
      .map((refund) => this.rebuild(refund, refund.id!));
  }

  private rebuild(refund: Refund, id: number): Refund {
    const now = new Date('2026-06-12T00:00:00.000Z');
    return Refund.reconstitute({
      id,
      orderId: refund.orderId,
      paymentId: refund.paymentId,
      amountMinor: refund.amountMinor,
      currency: refund.currency,
      status: refund.status,
      reason: refund.reason,
      gatewayReference: refund.gatewayReference,
      issuedAt: refund.issuedAt,
      createdAt: refund.createdAt ?? now,
      updatedAt: refund.updatedAt ?? now,
    });
  }
}

export const buildRefundFixture = (
  id: number,
  orderId: number,
  paymentId: number,
  status: RefundStatusEnum = RefundStatusEnum.ISSUED,
  amountMinor = 1000,
  reason = 'customer-return',
): Refund =>
  Refund.reconstitute({
    id,
    orderId,
    paymentId,
    amountMinor,
    currency: 'USD',
    status,
    reason,
    gatewayReference: status === RefundStatusEnum.ISSUED ? `fake_refund_${id}` : null,
    issuedAt: status === RefundStatusEnum.ISSUED ? new Date('2026-06-12T00:00:00.000Z') : null,
    createdAt: new Date('2026-06-12T00:00:00.000Z'),
    updatedAt: new Date('2026-06-12T00:00:00.000Z'),
  });

export class FakeOrderCommitSaleGateway implements IOrderCommitSaleGatewayPort {
  public readonly calls: ICommitSalePayload[] = [];
  public commitError: Error | null = null;

  public commitSale(payload: ICommitSalePayload): Promise<ICommitSaleResult> {
    this.calls.push(payload);
    if (this.commitError !== null) {
      return Promise.reject(this.commitError);
    }
    return Promise.resolve({
      committed: payload.lines.map((line) => ({
        variantId: line.variantId,
        stockLocationId: line.stockLocationId ?? 'default-warehouse',
        quantity: line.quantity,
      })),
    });
  }
}

export class FakeFulfillmentRepository implements IFulfillmentRepositoryPort {
  public saveCount = 0;
  private seq = 0;
  private lineSeq = 0;
  private readonly byId = new Map<number, Fulfillment>();

  public save(fulfillment: Fulfillment): Promise<Fulfillment> {
    this.saveCount += 1;
    const id = fulfillment.id ?? ++this.seq;
    const stored = this.rebuild(fulfillment, id);
    this.byId.set(id, stored);
    return Promise.resolve(this.rebuild(stored, id));
  }

  public snapshot(): () => void {
    const copy = new Map(this.byId);
    return (): void => {
      this.byId.clear();
      for (const [k, v] of copy) this.byId.set(k, v);
    };
  }

  public findById(id: number): Promise<Fulfillment | null> {
    const fulfillment = this.byId.get(id);
    return Promise.resolve(fulfillment ? this.rebuild(fulfillment, id) : null);
  }

  public findByIdForUpdate(id: number): Promise<Fulfillment | null> {
    return this.findById(id);
  }

  public listByOrderId(orderId: number): Promise<Fulfillment[]> {
    const ordered = [...this.byId.values()]
      .filter((fulfillment) => fulfillment.orderId === orderId)
      .sort((a, b) => {
        const byShipped = (b.shippedAt?.getTime() ?? 0) - (a.shippedAt?.getTime() ?? 0);
        return byShipped !== 0 ? byShipped : (b.id ?? 0) - (a.id ?? 0);
      });
    return Promise.resolve(
      ordered.map((fulfillment) => this.rebuild(fulfillment, fulfillment.id!)),
    );
  }

  private rebuild(fulfillment: Fulfillment, id: number): Fulfillment {
    return Fulfillment.reconstitute({
      id,
      orderId: fulfillment.orderId,
      stockLocationId: fulfillment.stockLocationId,
      status: fulfillment.status,
      trackingNumber: fulfillment.trackingNumber,
      carrier: fulfillment.carrier,
      shippedAt: fulfillment.shippedAt,
      deliveredAt: fulfillment.deliveredAt,
      lines: fulfillment.lines.map(
        (line) =>
          new FulfillmentLine({
            id: line.id ?? ++this.lineSeq,
            fulfillmentId: id,
            orderLineId: line.orderLineId,
            quantity: line.quantity,
          }),
      ),
      version: fulfillment.version,
    });
  }
}

interface IFakeStoredRow extends Omit<IIdempotencyRecord, 'responseStatus' | 'responseBody'> {
  responseStatus: number | null;
  responseBody: Record<string, unknown> | null;
}

export class FakeIdempotencyStore implements IIdempotencyStorePort {
  public readonly saved: IIdempotencyRecordInput[] = [];
  public readonly reserved: IIdempotencyReserveInput[] = [];
  public readonly finalized: IIdempotencyFinalizeInput[] = [];
  public readonly released: string[] = [];
  public findCalls = 0;
  public reserveCalls = 0;
  private readonly rows = new Map<string, IFakeStoredRow>();
  private winner: IIdempotencyRecord | null = null;

  private static keyOf(scope: string, key: string): string {
    return `${scope}::${key}`;
  }

  public seed(record: IIdempotencyRecord): void {
    this.rows.set(FakeIdempotencyStore.keyOf(record.scope, record.key), { ...record });
  }

  public armConcurrentWinner(record: IIdempotencyRecord): void {
    this.winner = record;
  }

  public find(scope: string, key: string): Promise<IIdempotencyRecord | null> {
    this.findCalls += 1;
    const k = FakeIdempotencyStore.keyOf(scope, key);
    if (this.winner && this.findCalls > 1) {
      this.rows.set(k, { ...this.winner });
    }
    const row = this.rows.get(k);
    if (!row) {
      return Promise.resolve(null);
    }
    if (row.responseBody === null) {
      return Promise.resolve(null);
    }
    return Promise.resolve(FakeIdempotencyStore.toRecord(row));
  }

  public save(record: IIdempotencyRecordInput): Promise<void> {
    this.saved.push(record);
    const k = FakeIdempotencyStore.keyOf(record.scope, record.key);
    if (this.winner || this.rows.has(k)) {
      return Promise.resolve();
    }
    this.rows.set(k, {
      ...record,
      createdAt: new Date('2026-06-10T00:00:00.000Z'),
      expiresAt: new Date('2026-06-11T00:00:00.000Z'),
    });
    return Promise.resolve();
  }

  public reserve(input: IIdempotencyReserveInput): Promise<IIdempotencyReservation> {
    this.reserveCalls += 1;
    this.reserved.push(input);
    const k = FakeIdempotencyStore.keyOf(input.scope, input.key);
    const existing = this.rows.get(k);
    if (!existing) {
      this.rows.set(k, {
        scope: input.scope,
        key: input.key,
        requestFingerprint: input.requestFingerprint,
        responseStatus: null,
        responseBody: null,
        createdAt: new Date('2026-06-10T00:00:00.000Z'),
        expiresAt: new Date('2026-06-11T00:00:00.000Z'),
      });
      return Promise.resolve({ outcome: 'reserved' });
    }
    if (existing.requestFingerprint !== input.requestFingerprint) {
      return Promise.resolve({ outcome: 'mismatch' });
    }
    if (existing.responseBody === null) {
      return Promise.resolve({ outcome: 'in-progress' });
    }
    return Promise.resolve({ outcome: 'replay', record: FakeIdempotencyStore.toRecord(existing) });
  }

  public finalize(input: IIdempotencyFinalizeInput): Promise<void> {
    this.finalized.push(input);
    const row = this.rows.get(FakeIdempotencyStore.keyOf(input.scope, input.key));
    if (row) {
      row.responseStatus = input.responseStatus;
      row.responseBody = input.responseBody;
    }
    return Promise.resolve();
  }

  public release(scope: string, key: string): Promise<void> {
    const k = FakeIdempotencyStore.keyOf(scope, key);
    this.released.push(k);
    if (this.rows.get(k)?.responseBody === null) {
      this.rows.delete(k);
    }
    return Promise.resolve();
  }

  public deleteExpired(now: Date): Promise<number> {
    let deleted = 0;
    for (const [k, record] of this.rows) {
      if (record.expiresAt.getTime() < now.getTime()) {
        this.rows.delete(k);
        deleted += 1;
      }
    }
    return Promise.resolve(deleted);
  }

  private static toRecord(row: IFakeStoredRow): IIdempotencyRecord {
    return {
      scope: row.scope,
      key: row.key,
      requestFingerprint: row.requestFingerprint,
      responseStatus: row.responseStatus!,
      responseBody: row.responseBody!,
      createdAt: row.createdAt,
      expiresAt: row.expiresAt,
    };
  }
}

export const buildIdempotencyRecord = (
  overrides: Partial<IIdempotencyRecord> = {},
): IIdempotencyRecord => ({
  scope: 'place-order',
  key: 'idem-1',
  requestFingerprint: 'fingerprint-placeholder',
  responseStatus: 201,
  responseBody: { id: 777, orderNumber: 'ORD-2026-00000777' },
  createdAt: new Date('2026-06-10T00:00:00.000Z'),
  expiresAt: new Date('2026-06-11T00:00:00.000Z'),
  ...overrides,
});

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

export const buildOrderFixture = (
  id: number,
  customerId: string | null,
  paymentStatus: OrderPaymentStatusEnum = OrderPaymentStatusEnum.AUTHORIZED,
  unitPriceMinor = 1000,
  placedAt: Date = new Date('2026-06-10T00:00:00.000Z'),
): Order =>
  Order.reconstitute({
    id,
    orderNumber: `ORD-2026-${String(id).padStart(8, '0')}`,
    customerId,
    currency: 'USD',
    status: OrderStatusEnum.PENDING,
    paymentStatus,
    fulfillmentStatus: OrderFulfillmentStatusEnum.UNFULFILLED,
    lines: [
      new OrderLine({
        id: id * 1000,
        variantId: 1,
        sku: 'SKU-1',
        nameSnapshot: 'Item One',
        quantity: 1,
        unitPriceMinor,
        taxAmountMinor: 0,
        discountAmountMinor: 0,
        status: OrderLineStatusEnum.ALLOCATED,
      }),
    ],
    subtotalMinor: unitPriceMinor,
    taxTotalMinor: 0,
    discountTotalMinor: 0,
    shippingTotalMinor: 0,
    grandTotalMinor: unitPriceMinor,
    billingAddressId: null,
    shippingAddressId: null,
    sourceCartId: `cart-${id}`,
    placedAt,
    version: 2,
  });

export const buildOrderWithLinesFixture = (
  id: number,
  customerId: string | null,
  lines: { orderLineId: number; quantity: number; cancelledQuantity?: number }[],
  opts: {
    status?: OrderStatusEnum;
    paymentStatus?: OrderPaymentStatusEnum;
    fulfillmentStatus?: OrderFulfillmentStatusEnum;
    unitPriceMinor?: number;
  } = {},
): Order => {
  const unitPriceMinor = opts.unitPriceMinor ?? 1000;
  const orderLines = lines.map((line) => {
    const cancelledQuantity = line.cancelledQuantity ?? 0;
    return new OrderLine({
      id: line.orderLineId,
      variantId: line.orderLineId,
      sku: `SKU-${line.orderLineId}`,
      nameSnapshot: `Item ${line.orderLineId}`,
      quantity: line.quantity,
      cancelledQuantity,
      unitPriceMinor,
      taxAmountMinor: 0,
      discountAmountMinor: 0,
      status:
        cancelledQuantity === line.quantity
          ? OrderLineStatusEnum.CANCELLED
          : OrderLineStatusEnum.ALLOCATED,
    });
  });
  const subtotalMinor = orderLines.reduce((sum, line) => sum + line.lineTotalMinor, 0);
  return Order.reconstitute({
    id,
    orderNumber: `ORD-2026-${String(id).padStart(8, '0')}`,
    customerId,
    currency: 'USD',
    status: opts.status ?? OrderStatusEnum.PENDING,
    paymentStatus: opts.paymentStatus ?? OrderPaymentStatusEnum.AUTHORIZED,
    fulfillmentStatus: opts.fulfillmentStatus ?? OrderFulfillmentStatusEnum.UNFULFILLED,
    lines: orderLines,
    subtotalMinor,
    taxTotalMinor: 0,
    discountTotalMinor: 0,
    shippingTotalMinor: 0,
    grandTotalMinor: subtotalMinor,
    billingAddressId: null,
    shippingAddressId: null,
    sourceCartId: `cart-${id}`,
    placedAt: new Date('2026-06-10T00:00:00.000Z'),
    version: 2,
  });
};

export const buildPaymentFixture = (
  id: number,
  orderId: number,
  status: PaymentStatusEnum = PaymentStatusEnum.AUTHORIZED,
  amountMinor = 1000,
): Payment =>
  Payment.reconstitute({
    id,
    orderId,
    amountMinor,
    currency: 'USD',
    method: 'fake-card',
    status,
    gatewayReference: `fake_ref_${id}`,
    authorizedAt: new Date('2026-06-10T00:00:00.000Z'),
    capturedAt: status === PaymentStatusEnum.CAPTURED ? new Date('2026-06-10T00:00:00.000Z') : null,
  });
