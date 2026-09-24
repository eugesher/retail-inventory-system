import {
  IRestockFromReturnPayload,
  IRestockFromReturnResult,
  IRetailReturnAuthorizedEvent,
  IRetailReturnClosedEvent,
  IRetailReturnInspectedEvent,
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
  IInventoryRestockGatewayPort,
  IReturnCustomerContact,
  IReturnCustomerContactReaderPort,
  IReturnEventsPublisherPort,
  IReturnOrderReaderPort,
  IReturnOrderSnapshot,
  IReturnRequestRepositoryPort,
  IReturnRequestWriteRepositoryPort,
  IReturnsUnitOfWork,
  IReturnsUnitOfWorkRunner,
} from '../../ports';
import { ReturnWriteConflictError } from '../return-write-conflict.error';

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

export class FakeReturnRequestRepository
  implements IReturnRequestRepositoryPort, IReturnRequestWriteRepositoryPort
{
  private readonly store = new Map<number, ReturnRequest>();
  private sequence = 0;
  public readonly saved: ReturnRequest[] = [];
  public conflictsBeforeSuccess = 0;

  public save(request: ReturnRequest, expectedVersion?: number): Promise<ReturnRequest> {
    if (expectedVersion !== undefined && this.conflictsBeforeSuccess > 0) {
      this.conflictsBeforeSuccess -= 1;
      const current = this.store.get(request.id!);
      return Promise.reject(
        new ReturnWriteConflictError(request.id!, current ? current.version : expectedVersion),
      );
    }
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

  public seed(request: ReturnRequest): ReturnRequest {
    const id = request.id ?? ++this.sequence;
    const persisted = reconstituteWithId(request, id);
    this.store.set(id, persisted);
    return persisted;
  }
}

export class FakeReturnOrderReader implements IReturnOrderReaderPort {
  constructor(private snapshot: IReturnOrderSnapshot | null) {}

  public findOrderForReturn(orderId: number): Promise<IReturnOrderSnapshot | null> {
    if (this.snapshot?.orderId !== orderId) {
      return Promise.resolve(null);
    }
    return Promise.resolve(this.snapshot);
  }

  public setSnapshot(snapshot: IReturnOrderSnapshot | null): void {
    this.snapshot = snapshot;
  }
}

export class SpyReturnEventsPublisher implements IReturnEventsPublisherPort {
  public readonly requested: IRetailReturnRequestedEvent[] = [];
  public readonly authorized: IRetailReturnAuthorizedEvent[] = [];
  public readonly rejected: IRetailReturnRejectedEvent[] = [];
  public readonly received: IRetailReturnReceivedEvent[] = [];
  public readonly inspected: IRetailReturnInspectedEvent[] = [];
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
  public publishReturnInspected(event: IRetailReturnInspectedEvent): Promise<void> {
    this.inspected.push(event);
    return Promise.resolve();
  }
  public publishReturnClosed(event: IRetailReturnClosedEvent): Promise<void> {
    this.closed.push(event);
    return Promise.resolve();
  }
}

export const FAKE_CUSTOMER_EMAIL = 'buyer@example.com';

export class FakeReturnCustomerContactReader implements IReturnCustomerContactReaderPort {
  public readonly calls: string[] = [];

  constructor(
    private readonly email: string | null = FAKE_CUSTOMER_EMAIL,
    private readonly found = true,
  ) {}

  public findContactByCustomerId(customerId: string): Promise<IReturnCustomerContact | null> {
    this.calls.push(customerId);
    return Promise.resolve(this.found ? { email: this.email } : null);
  }
}

export class FakeReturnsUnitOfWorkRunner implements IReturnsUnitOfWorkRunner {
  constructor(private readonly returnRequests: IReturnRequestWriteRepositoryPort) {}

  public run<T>(work: (uow: IReturnsUnitOfWork) => Promise<T>): Promise<T> {
    return work({ returnRequests: this.returnRequests });
  }
}

export class FakeInventoryRestockGateway implements IInventoryRestockGatewayPort {
  public readonly calls: IRestockFromReturnPayload[] = [];
  constructor(private readonly failure: Error | null = null) {}

  public restockFromReturn(payload: IRestockFromReturnPayload): Promise<IRestockFromReturnResult> {
    this.calls.push(payload);
    if (this.failure) {
      return Promise.reject(this.failure);
    }
    return Promise.resolve({
      restocked: payload.lines.map((line) => ({
        returnLineId: line.returnLineId,
        variantId: line.variantId,
        stockLocationId: line.stockLocationId,
        quantity: line.quantity,
      })),
    });
  }
}

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
