import { Inject, Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';

import { CartView, IRetailCartAddLinePayload } from '@retail-inventory-system/contracts';

import { CartDomainException, CartErrorCodeEnum } from '../../domain';
import {
  CART_CATALOG_GATEWAY,
  CART_EVENTS_PUBLISHER,
  CART_INVENTORY_GATEWAY,
  CART_REPOSITORY,
  ICartCatalogGatewayPort,
  ICartEventsPublisherPort,
  ICartInventoryGatewayPort,
  ICartRepositoryPort,
} from '../ports';
import { loadOwnedCart } from './cart-access';
import { toCartView } from './cart-view.factory';

// Adds a variant to the cart (or increments the existing line for that variant —
// the domain's increment-existing rule, ADR-028 §1). The unit price is
// snapshotted at add-time from the catalog `catalog.price.select` RPC in the
// cart's currency; an unknown or unpriced variant has no applicable price and is
// rejected (`CART_VARIANT_NOT_PRICED`, 409) rather than persisting a zero-price
// line. Before the cart is mutated the use case reserves the line's **absolute**
// target quantity against the inventory reservation surface (ADR-030) so the cart
// can never hold more units than stock allows (no-oversell). After save the use
// case emits the reserved `retail.cart.line-added` wire event (best-effort
// post-commit).
@Injectable()
export class AddToCartUseCase {
  constructor(
    @Inject(CART_REPOSITORY)
    private readonly repository: ICartRepositoryPort,
    @Inject(CART_CATALOG_GATEWAY)
    private readonly catalog: ICartCatalogGatewayPort,
    @Inject(CART_INVENTORY_GATEWAY)
    private readonly inventory: ICartInventoryGatewayPort,
    @Inject(CART_EVENTS_PUBLISHER)
    private readonly publisher: ICartEventsPublisherPort,
    @InjectPinoLogger(AddToCartUseCase.name)
    private readonly logger: PinoLogger,
  ) {}

  public async execute(payload: IRetailCartAddLinePayload): Promise<CartView> {
    const { cartId, customerId, variantId, quantity, correlationId } = payload;

    this.logger.info({ correlationId, cartId, variantId, quantity }, 'Adding line to cart');

    const cart = await loadOwnedCart(this.repository, cartId, customerId);

    // Snapshot the applicable price in the cart's currency. `null` = unknown or
    // unpriced variant — the line cannot be priced, so the add is rejected.
    const price = await this.catalog.selectApplicablePrice(variantId, cart.currency, correlationId);
    if (price === null) {
      throw new CartDomainException(
        CartErrorCodeEnum.CART_VARIANT_NOT_PRICED,
        `Variant ${variantId} has no applicable ${cart.currency} price; cannot add to cart`,
      );
    }

    // Reserve the line's ABSOLUTE target quantity (existing line qty + this add —
    // `addLine` increments an existing line) BEFORE mutating or saving the cart.
    // The reserve RPC is idempotent-by-absolute-quantity, so a repeat add re-sets
    // the hold to the new total and refreshes the TTL. An out-of-stock target
    // rejects with `INVENTORY_OUT_OF_STOCK` (409, carrying `details.available`) and
    // the cart is never touched. Reserve-before-save is deliberate: "reserved but
    // save failed" merely over-holds stock until release/TTL, whereas "saved but
    // not reserved" would reopen the oversell hole.
    const existing = cart.lines.find((line) => line.variantId === variantId);
    const targetQty = (existing?.quantity ?? 0) + quantity;
    await this.inventory.reserveStock({ variantId, quantity: targetQty, cartId, correlationId });

    cart.addLine({
      variantId,
      quantity,
      unitPriceSnapshotMinor: price.amountMinor,
      currencySnapshot: cart.currency,
    });

    const saved = await this.repository.save(cart);
    const occurredAt = (cart.pullDomainEvents()[0]?.occurredAt ?? new Date()).toISOString();

    try {
      await this.publisher.publishCartLineAdded({
        cartId,
        variantId,
        quantity,
        eventVersion: 'v1',
        occurredAt,
        correlationId,
      });
    } catch (err) {
      this.logger.warn(
        { err: err as Error, correlationId, cartId, variantId },
        'Failed to publish retail.cart.line-added event',
      );
    }

    this.logger.info(
      { correlationId, cartId, variantId, unitPriceSnapshotMinor: price.amountMinor },
      'Line added to cart',
    );
    return toCartView(saved);
  }
}
