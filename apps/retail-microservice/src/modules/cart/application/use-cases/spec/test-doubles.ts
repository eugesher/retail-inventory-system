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

// Jest-free so the production build (which excludes `*.spec.ts` but not
// `test-doubles.ts`) stays clean — the catalog/inventory convention.

// Builds a `PriceView` for the Add-to-Cart price-snapshot path. `amountMinor` is
// integer minor units (cents); the catalog gateway double stamps the requested
// variantId in.
export const makePriceView = (amountMinor: number): PriceView => ({
  id: 1,
  variantId: 0,
  currency: 'USD',
  amountMinor,
  validFrom: '2020-01-01T00:00:00.000Z',
  validTo: null,
  priority: 0,
});

// In-memory cart repository. `save` mirrors the TypeORM repository's post-commit
// re-read: it assigns concrete BIGINT ids to any new line and returns a
// reconstituted aggregate (carrying the bumped version), so use cases read
// concrete line ids back. `reassignCustomer` re-points the stored cart's owner
// and advances the version, matching the real `@VersionColumn` behaviour.
//
// The optimistic-concurrency contract (ADR-036) is modelled two ways:
//   * `conflictsBeforeSuccess` simulates a concurrent writer winning the race on
//     the next N version-checked saves — each such save advances the stored
//     version (so a retry re-reads a moved version) and rejects with a
//     `CartWriteConflictError`, without persisting;
//   * an `expectedVersion` that no longer matches the stored version rejects with
//     the same error (the CAS matched zero rows), carrying the current version.
export class InMemoryCartRepository implements ICartRepositoryPort {
  public readonly saved: Cart[] = [];

  // Set > 0 to make the next N version-checked saves lose the optimistic race.
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
    // Return a FRESH clone, never the stored reference — the real repository
    // re-reads a fresh aggregate from the DB on every `findById`, so a use case's
    // in-place mutation (and a retry re-loading the cart) must not corrupt the
    // stored state.
    return Promise.resolve(stored ? this.clone(stored) : null);
  }

  public save(cart: Cart, expectedVersion?: number): Promise<Cart> {
    const id = cart.id;
    if (id === null) {
      throw new Error('InMemoryCartRepository.save: cart id is unexpectedly null');
    }

    // Version-checked CAS path (an existing cart being updated).
    if (expectedVersion !== undefined) {
      const stored = this.store.get(id);
      const storedVersion = stored ? stored.version : expectedVersion;

      if (this.conflictsBeforeSuccess > 0) {
        this.conflictsBeforeSuccess -= 1;
        // A concurrent winner advanced the row; a retry re-reads the moved version.
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

    // Create / version-agnostic path (no live row to race).
    const persisted = this.persist(cart, id, cart.version);
    return Promise.resolve(persisted);
  }

  // Stores the cart (assigning concrete line ids) at the given version and records
  // the write for assertions, returning the reconstituted post-commit aggregate.
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

  // Rebuilds the stored cart at a bumped version, keeping its lines — models a
  // concurrent writer that advanced only the optimistic-lock token.
  private rebuildAtVersion(existing: Cart, version: number): Cart {
    return this.clone(existing, version);
  }

  // A fresh reconstituted copy (deep on the lines), optionally at a new version.
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

// In-memory catalog price gateway. By default it returns a $49.99 price; set
// `nextPrice = null` to simulate an unknown/unpriced variant. Each call is
// recorded so a spec can assert the cart's currency was passed through.
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

// Builds a wire-shaped RPC rejection: an `Error` (so it satisfies the
// reject-with-Error lint rule and `instanceof Error`) carrying the
// `{ statusCode, code, details }` fields the inventory RPC filter emits and the
// gateway's `throwRpcError` reads. `toMatchObject({ code, details })` matches the
// Error's own enumerable props.
export const makeWireError = (
  code: string,
  statusCode: number,
  message: string,
  details?: Record<string, unknown>,
): Error =>
  Object.assign(new Error(message), { statusCode, code, ...(details ? { details } : {}) });

// In-memory cart→inventory reservation gateway. Records every reserve/release
// call so specs can assert the absolute quantity / selector passed, and exposes a
// programmable rejection (`reserveError` / `releaseError`) so a spec can simulate
// an `INVENTORY_OUT_OF_STOCK` reserve or a failed release. The reserve default
// echoes the requested quantity back as an `active` hold.
export class InMemoryCartInventoryGateway implements ICartInventoryGatewayPort {
  public readonly reserveCalls: IReservationReservePayload[] = [];
  public readonly releaseCalls: IReservationReleasePayload[] = [];
  // Set to make the NEXT (and every) call reject with this. Use `makeWireError`
  // to build a wire-shaped rejection (an Error carrying `statusCode`/`code`/
  // `details`), mirroring the `{ statusCode, message, code, details }` the gateway
  // ultimately surfaces.
  public reserveError: Error | null = null;
  public releaseError: Error | null = null;

  public reserveStock(payload: IReservationReservePayload): Promise<ReservationView> {
    this.reserveCalls.push(payload);
    // Model the real reserve RPC's positive-int guard (RESERVATION_QUANTITY_INVALID,
    // 400) so the fake is faithful on the reserve-before-mutate path.
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

// Recording cart events publisher — collects each emitted wire event per kind so
// specs can assert the right event fired with the right payload.
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
