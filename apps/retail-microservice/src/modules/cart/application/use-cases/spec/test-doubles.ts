import {
  IReservationReleasePayload,
  IReservationReleaseResult,
  IReservationReservePayload,
  IRetailCartCreatedEvent,
  IRetailCartLineAddedEvent,
  IRetailCartLineQuantityChangedEvent,
  IRetailCartLineRemovedEvent,
  PriceView,
  ReservationView,
} from '@retail-inventory-system/contracts';

import { Cart, CartLine } from '../../../domain';
import {
  ICartCatalogGatewayPort,
  ICartEventsPublisherPort,
  ICartInventoryGatewayPort,
  ICartRepositoryPort,
} from '../../ports';
import { CartWriteConflictError } from '../cart-write-conflict.error';

export const makePriceView = (amountMinor: number): PriceView => ({
  id: 1,
  variantId: 0,
  currency: 'USD',
  amountMinor,
  validFrom: '2020-01-01T00:00:00.000Z',
  validTo: null,
  priority: 0,
});

export class InMemoryCartRepository implements ICartRepositoryPort {
  public readonly saved: Cart[] = [];

  public conflictsBeforeSuccess = 0;

  private readonly store = new Map<string, Cart>();
  private nextLineId = 5000;

  public seed(cart: Cart): void {
    if (cart.id === null) {
      throw new Error('InMemoryCartRepository.seed: aggregate must be persisted (id !== null)');
    }
    this.store.set(cart.id, cart);
  }

  public findById(id: string): Promise<Cart | null> {
    const stored = this.store.get(id);
    return Promise.resolve(stored ? this.clone(stored) : null);
  }

  public save(cart: Cart, expectedVersion?: number): Promise<Cart> {
    const id = cart.id;
    if (id === null) {
      throw new Error('InMemoryCartRepository.save: cart id is unexpectedly null');
    }

    if (expectedVersion !== undefined) {
      const stored = this.store.get(id);
      const storedVersion = stored ? stored.version : expectedVersion;

      if (this.conflictsBeforeSuccess > 0) {
        this.conflictsBeforeSuccess -= 1;
        if (stored) {
          this.store.set(id, this.rebuildAtVersion(stored, storedVersion + 1));
        }
        return Promise.reject(new CartWriteConflictError(id, storedVersion + 1));
      }

      if (storedVersion !== expectedVersion) {
        return Promise.reject(new CartWriteConflictError(id, storedVersion));
      }

      const persisted = this.persist(cart, id, expectedVersion + 1);
      return Promise.resolve(persisted);
    }

    const persisted = this.persist(cart, id, cart.version);
    return Promise.resolve(persisted);
  }

  private persist(cart: Cart, id: string, version: number): Cart {
    const lines = cart.lines.map(
      (line) =>
        new CartLine({
          id: line.id ?? this.nextLineId++,
          variantId: line.variantId,
          quantity: line.quantity,
          unitPriceSnapshotMinor: line.unitPriceSnapshotMinor,
          currencySnapshot: line.currencySnapshot,
        }),
    );
    const persisted = Cart.reconstitute({
      id,
      customerId: cart.customerId,
      currency: cart.currency,
      status: cart.status,
      lines,
      expiresAt: cart.expiresAt,
      version,
    });
    this.store.set(id, persisted);
    this.saved.push(persisted);
    return persisted;
  }

  private rebuildAtVersion(existing: Cart, version: number): Cart {
    return this.clone(existing, version);
  }

  private clone(cart: Cart, version?: number): Cart {
    return Cart.reconstitute({
      id: cart.id,
      customerId: cart.customerId,
      currency: cart.currency,
      status: cart.status,
      lines: cart.lines.map(
        (line) =>
          new CartLine({
            id: line.id,
            variantId: line.variantId,
            quantity: line.quantity,
            unitPriceSnapshotMinor: line.unitPriceSnapshotMinor,
            currencySnapshot: line.currencySnapshot,
          }),
      ),
      expiresAt: cart.expiresAt,
      version: version ?? cart.version,
    });
  }

  public reassignCustomer(cartId: string, customerId: string): Promise<void> {
    const existing = this.store.get(cartId);
    if (!existing) return Promise.resolve();
    const reassigned = Cart.reconstitute({
      id: existing.id,
      customerId,
      currency: existing.currency,
      status: existing.status,
      lines: [...existing.lines],
      expiresAt: existing.expiresAt,
      version: existing.version + 1,
    });
    this.store.set(cartId, reassigned);
    return Promise.resolve();
  }
}

export class InMemoryCartCatalogGateway implements ICartCatalogGatewayPort {
  public nextPrice: PriceView | null = makePriceView(4999);
  public readonly calls: { variantId: number; currency: string; correlationId?: string }[] = [];

  public selectApplicablePrice(
    variantId: number,
    currency: string,
    correlationId?: string,
  ): Promise<PriceView | null> {
    this.calls.push({ variantId, currency, correlationId });
    return Promise.resolve(this.nextPrice ? { ...this.nextPrice, variantId } : null);
  }
}

export const makeWireError = (
  code: string,
  statusCode: number,
  message: string,
  details?: Record<string, unknown>,
): Error =>
  Object.assign(new Error(message), { statusCode, code, ...(details ? { details } : {}) });

export class InMemoryCartInventoryGateway implements ICartInventoryGatewayPort {
  public readonly reserveCalls: IReservationReservePayload[] = [];
  public readonly releaseCalls: IReservationReleasePayload[] = [];
  public reserveError: Error | null = null;
  public releaseError: Error | null = null;

  public reserveStock(payload: IReservationReservePayload): Promise<ReservationView> {
    this.reserveCalls.push(payload);
    if (!Number.isInteger(payload.quantity) || payload.quantity <= 0) {
      return Promise.reject(
        makeWireError(
          'INVENTORY_RESERVATION_QUANTITY_INVALID',
          400,
          `Reservation quantity must be a positive integer, got ${payload.quantity}`,
        ),
      );
    }
    if (this.reserveError !== null) {
      return Promise.reject(this.reserveError);
    }
    return Promise.resolve({
      reservationId: 'res-1',
      variantId: payload.variantId,
      stockLocationId: payload.stockLocationId ?? 'default-warehouse',
      quantity: payload.quantity,
      cartId: payload.cartId,
      expiresAt: '2026-06-14T00:15:00.000Z',
      status: 'active',
    });
  }

  public releaseStock(payload: IReservationReleasePayload): Promise<IReservationReleaseResult> {
    this.releaseCalls.push(payload);
    if (this.releaseError !== null) {
      return Promise.reject(this.releaseError);
    }
    return Promise.resolve({ released: [] });
  }
}

export class InMemoryCartEventsPublisher implements ICartEventsPublisherPort {
  public readonly created: { event: IRetailCartCreatedEvent }[] = [];
  public readonly lineAdded: { event: IRetailCartLineAddedEvent }[] = [];
  public readonly lineRemoved: { event: IRetailCartLineRemovedEvent }[] = [];
  public readonly lineQuantityChanged: { event: IRetailCartLineQuantityChangedEvent }[] = [];

  public publishCartCreated(event: IRetailCartCreatedEvent): Promise<void> {
    this.created.push({ event });
    return Promise.resolve();
  }

  public publishCartLineAdded(event: IRetailCartLineAddedEvent): Promise<void> {
    this.lineAdded.push({ event });
    return Promise.resolve();
  }

  public publishCartLineRemoved(event: IRetailCartLineRemovedEvent): Promise<void> {
    this.lineRemoved.push({ event });
    return Promise.resolve();
  }

  public publishCartLineQuantityChanged(event: IRetailCartLineQuantityChangedEvent): Promise<void> {
    this.lineQuantityChanged.push({ event });
    return Promise.resolve();
  }
}
