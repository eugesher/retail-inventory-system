import { Inject, Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';

import { CartView, IRetailCartChangeLineQuantityPayload } from '@retail-inventory-system/contracts';

import { CartDomainException, CartErrorCodeEnum } from '../../domain';
import {
  CART_EVENTS_PUBLISHER,
  CART_INVENTORY_GATEWAY,
  CART_REPOSITORY,
  ICartEventsPublisherPort,
  ICartInventoryGatewayPort,
  ICartRepositoryPort,
} from '../ports';
import { loadOwnedCart } from './cart-access';
import { toCartView } from './cart-view.factory';

// Sets a cart line's quantity to a new positive value. A `0` is rejected at the
// domain (`CART_LINE_QUANTITY_INVALID`) — removal is the explicit op; an unknown
// line id is a 404 (`CART_LINE_NOT_FOUND`). Before the cart is mutated the use
// case re-reserves the line's **absolute new** quantity against the inventory
// reservation surface (ADR-030); the reserve RPC's idempotent-absolute semantics
// adjust the counter delta and refresh the TTL in either direction (up or down).
// After save the use case emits the reserved `retail.cart.line-quantity-changed`
// wire event (best-effort post-commit).
@Injectable()
export class ChangeCartLineQuantityUseCase {
  constructor(
    @Inject(CART_REPOSITORY)
    private readonly repository: ICartRepositoryPort,
    @Inject(CART_INVENTORY_GATEWAY)
    private readonly inventory: ICartInventoryGatewayPort,
    @Inject(CART_EVENTS_PUBLISHER)
    private readonly publisher: ICartEventsPublisherPort,
    @InjectPinoLogger(ChangeCartLineQuantityUseCase.name)
    private readonly logger: PinoLogger,
  ) {}

  public async execute(payload: IRetailCartChangeLineQuantityPayload): Promise<CartView> {
    const { cartId, customerId, lineId, quantity, correlationId } = payload;

    this.logger.info({ correlationId, cartId, lineId, quantity }, 'Changing cart line quantity');

    const cart = await loadOwnedCart(this.repository, cartId, customerId);

    // Resolve the line up front so the reserve can carry its `variantId` (the same
    // `CART_LINE_NOT_FOUND` guard the domain `changeLineQuantity` enforces). Then
    // re-reserve the absolute new quantity BEFORE mutating/saving — a rejection
    // (e.g. raising the quantity past available stock → `INVENTORY_OUT_OF_STOCK`,
    // 409) leaves the cart untouched.
    const line = cart.lines.find((candidate) => candidate.id === lineId);
    if (!line) {
      throw new CartDomainException(
        CartErrorCodeEnum.CART_LINE_NOT_FOUND,
        `Cart ${cartId}: no line with id ${lineId}`,
      );
    }
    await this.inventory.reserveStock({
      variantId: line.variantId,
      quantity,
      cartId,
      correlationId,
    });

    cart.changeLineQuantity(lineId, quantity);

    const saved = await this.repository.save(cart);
    const occurredAt = (cart.pullDomainEvents()[0]?.occurredAt ?? new Date()).toISOString();

    try {
      await this.publisher.publishCartLineQuantityChanged({
        cartId,
        lineId,
        quantity,
        eventVersion: 'v1',
        occurredAt,
        correlationId,
      });
    } catch (err) {
      this.logger.warn(
        { err: err as Error, correlationId, cartId, lineId },
        'Failed to publish retail.cart.line-quantity-changed event',
      );
    }

    this.logger.info({ correlationId, cartId, lineId, quantity }, 'Cart line quantity changed');
    return toCartView(saved);
  }
}
