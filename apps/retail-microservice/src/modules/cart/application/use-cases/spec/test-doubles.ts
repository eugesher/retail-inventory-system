import {
  IRetailCartCreatedEvent,
  IRetailCartLineAddedEvent,
  IRetailCartLineQuantityChangedEvent,
  IRetailCartLineRemovedEvent,
  PriceView,
} from '@retail-inventory-system/contracts';

import { Cart, CartLine } from '../../../domain';
import {
  ICartCatalogGatewayPort,
  ICartEventsPublisherPort,
  ICartRepositoryPort,
} from '../../ports';

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
export class InMemoryCartRepository implements ICartRepositoryPort {
  public readonly saved: Cart[] = [];

  private readonly store = new Map<string, Cart>();
  private nextLineId = 5000;

  public seed(cart: Cart): void {
    if (cart.id === null) {
      throw new Error('InMemoryCartRepository.seed: aggregate must be persisted (id !== null)');
    }
    this.store.set(cart.id, cart);
  }

  public findById(id: string): Promise<Cart | null> {
    return Promise.resolve(this.store.get(id) ?? null);
  }

  public save(cart: Cart): Promise<Cart> {
    const id = cart.id;
    if (id === null) {
      throw new Error('InMemoryCartRepository.save: cart id is unexpectedly null');
    }
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
      version: cart.version,
    });
    this.store.set(id, persisted);
    this.saved.push(persisted);
    return Promise.resolve(persisted);
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
