import {
  IRetailReturnAuthorizedEvent,
  IRetailReturnClosedEvent,
  IRetailReturnReceivedEvent,
  IRetailReturnRejectedEvent,
  IRetailReturnRequestedEvent,
  OrderFulfillmentStatusEnum,
  OrderStatusEnum,
  ReturnReasonCategoryEnum,
  ReturnStatusEnum,
} from '@retail-inventory-system/contracts';

import { ReturnLine, ReturnRequest } from '../../../domain';
import {
  IReturnEventsPublisherPort,
  IReturnOrderReaderPort,
  IReturnOrderSnapshot,
  IReturnRequestRepositoryPort,
} from '../../ports';

// Re-reconstitutes a return request with a concrete id (and concrete line ids), the way a
// real repository's save → re-read would. Used both to persist a freshly-opened request
// and to hand back an independent copy on each read (so a use case mutating its loaded
// aggregate cannot leak into the store before it saves).
const reconstituteWithId = (request: ReturnRequest, id: number): ReturnRequest => {
  const year = request.requestedAt.getUTCFullYear();
  const rmaNumber = request.rmaNumber ?? `RMA-${year}-${String(id).padStart(8, '0')}`;
  const lines = request.lines.map(
    (line, index) =>
      new ReturnLine({
        id: line.id ?? id * 1000 + index + 1,
        returnRequestId: id,
        orderLineId: line.orderLineId,
        quantity: line.quantity,
        condition: line.condition,
        disposition: line.disposition,
        lineRefundAmountMinor: line.lineRefundAmountMinor,
      }),
  );
  return ReturnRequest.reconstitute({
    id,
    rmaNumber,
    orderId: request.orderId,
    customerId: request.customerId,
    status: request.status,
    reasonCategory: request.reasonCategory,
    notes: request.notes,
    requestedAt: request.requestedAt,
    authorizedAt: request.authorizedAt,
    closedAt: request.closedAt,
    lines,
    version: request.version,
    createdAt: request.createdAt ?? new Date(),
    updatedAt: new Date(),
  });
};

// In-memory `IReturnRequestRepositoryPort` double. `save` assigns the BIGINT id + finalizes
// the RMA number on a new request (mirroring the real repo's re-read-then-finalize), and
// re-persists an existing one; every read returns an independent reconstituted copy.
export class FakeReturnRequestRepository implements IReturnRequestRepositoryPort {
  private readonly store = new Map<number, ReturnRequest>();
  private sequence = 0;
  public readonly saved: ReturnRequest[] = [];

  // Jest-free, non-`async` (returns `Promise.resolve(...)`) so the require-await /
  // no-floating lint rules stay satisfied — the orders `test-doubles` convention.
  public save(request: ReturnRequest): Promise<ReturnRequest> {
    const id = request.id ?? ++this.sequence;
    const persisted = reconstituteWithId(request, id);
    this.store.set(id, persisted);
    this.saved.push(persisted);
    return Promise.resolve(reconstituteWithId(persisted, id));
  }

  public findById(id: number): Promise<ReturnRequest | null> {
    const found = this.store.get(id);
    return Promise.resolve(found ? reconstituteWithId(found, id) : null);
  }

  public listByOrderId(orderId: number): Promise<ReturnRequest[]> {
    return Promise.resolve(
      [...this.store.values()]
        .filter((request) => request.orderId === orderId)
        .sort((a, b) => b.requestedAt.getTime() - a.requestedAt.getTime() || b.id! - a.id!)
        .map((request) => reconstituteWithId(request, request.id!)),
    );
  }

  // Test helper: seed an already-persisted RMA (e.g. a previous return on the same order,
  // or an RMA already at a given lifecycle status) directly into the store.
  public seed(request: ReturnRequest): ReturnRequest {
    const id = request.id ?? ++this.sequence;
    const persisted = reconstituteWithId(request, id);
    this.store.set(id, persisted);
    return persisted;
  }
}

// Configurable `IReturnOrderReaderPort` double — returns the snapshot it was handed, or
// `null` to simulate a missing order.
export class FakeReturnOrderReader implements IReturnOrderReaderPort {
  constructor(private snapshot: IReturnOrderSnapshot | null) {}

  public findOrderForReturn(orderId: number): Promise<IReturnOrderSnapshot | null> {
    // Return the configured snapshot only when its order id matches the request — a
    // mismatch (or a null snapshot) reads as a missing order. Uses the param meaningfully.
    if (this.snapshot?.orderId !== orderId) {
      return Promise.resolve(null);
    }
    return Promise.resolve(this.snapshot);
  }

  public setSnapshot(snapshot: IReturnOrderSnapshot | null): void {
    this.snapshot = snapshot;
  }
}

// Records every emitted event by type so a spec can assert the right one fired (the
// `SpyOrderEventsPublisher` precedent).
export class SpyReturnEventsPublisher implements IReturnEventsPublisherPort {
  public readonly requested: IRetailReturnRequestedEvent[] = [];
  public readonly authorized: IRetailReturnAuthorizedEvent[] = [];
  public readonly rejected: IRetailReturnRejectedEvent[] = [];
  public readonly received: IRetailReturnReceivedEvent[] = [];
  public readonly closed: IRetailReturnClosedEvent[] = [];

  public publishReturnRequested(event: IRetailReturnRequestedEvent): Promise<void> {
    this.requested.push(event);
    return Promise.resolve();
  }
  public publishReturnAuthorized(event: IRetailReturnAuthorizedEvent): Promise<void> {
    this.authorized.push(event);
    return Promise.resolve();
  }
  public publishReturnRejected(event: IRetailReturnRejectedEvent): Promise<void> {
    this.rejected.push(event);
    return Promise.resolve();
  }
  public publishReturnReceived(event: IRetailReturnReceivedEvent): Promise<void> {
    this.received.push(event);
    return Promise.resolve();
  }
  public publishReturnClosed(event: IRetailReturnClosedEvent): Promise<void> {
    this.closed.push(event);
    return Promise.resolve();
  }
}

// A delivered-order snapshot (always returnable), the default the Open specs measure
// against. `lines` default to one line (10) ordered 3, none cancelled.
export const buildOrderSnapshot = (
  overrides: Partial<IReturnOrderSnapshot> = {},
): IReturnOrderSnapshot => ({
  orderId: 1,
  customerId: '11111111-1111-4111-8111-111111111111',
  status: OrderStatusEnum.DELIVERED,
  fulfillmentStatus: OrderFulfillmentStatusEnum.DELIVERED,
  shippedAt: new Date('2026-06-01T00:00:00Z'),
  deliveredAt: new Date('2026-06-03T00:00:00Z'),
  lines: [{ orderLineId: 10, variantId: 100, quantity: 3, cancelledQuantity: 0 }],
  ...overrides,
});

const RETURN_OWNER_ID = '11111111-1111-4111-8111-111111111111';

// Builds a persisted RMA already at a given lifecycle `status` (id 7, one line) — the
// fixture the authorize/reject/receive/close specs seed before exercising the transition.
export const buildPersistedReturn = (
  status: ReturnStatusEnum,
  overrides: { id?: number; orderId?: number; customerId?: string } = {},
): ReturnRequest =>
  ReturnRequest.reconstitute({
    id: overrides.id ?? 7,
    rmaNumber: `RMA-2026-${String(overrides.id ?? 7).padStart(8, '0')}`,
    orderId: overrides.orderId ?? 1,
    customerId: overrides.customerId ?? RETURN_OWNER_ID,
    status,
    reasonCategory: ReturnReasonCategoryEnum.DEFECTIVE,
    notes: null,
    requestedAt: new Date('2026-06-10T00:00:00Z'),
    authorizedAt: status === ReturnStatusEnum.REQUESTED ? null : new Date('2026-06-11T00:00:00Z'),
    closedAt: null,
    lines: ReturnRequest.open({
      orderId: overrides.orderId ?? 1,
      customerId: overrides.customerId ?? RETURN_OWNER_ID,
      reasonCategory: ReturnReasonCategoryEnum.DEFECTIVE,
      notes: null,
      lines: [{ orderLineId: 10, quantity: 2 }],
    }).lines.slice(),
    version: 1,
  });
