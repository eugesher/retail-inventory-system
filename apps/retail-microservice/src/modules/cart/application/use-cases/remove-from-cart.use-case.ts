import { Inject, Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';

import { CartView, IRetailCartRemoveLinePayload } from '@retail-inventory-system/contracts';

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

// Drops a line from the cart. An unknown line id is a 404
// (`CART_LINE_NOT_FOUND`). The repository reconciles the removed row away inside
// the save transaction. After a successful save the use case releases the line's
// stock hold against the inventory reservation surface (ADR-030) — **best-effort**
// (try/warn/swallow): the cart write is the primary outcome, so a failed release
// (which merely over-holds stock until the manual release endpoint or a later TTL
// sweep frees it) never fails the remove. After save the use case also emits the
// reserved `retail.cart.line-removed` wire event (best-effort post-commit).
@Injectable()
export class RemoveFromCartUseCase {
  constructor(
    @Inject(CART_REPOSITORY)
    private readonly repository: ICartRepositoryPort,
    @Inject(CART_INVENTORY_GATEWAY)
    private readonly inventory: ICartInventoryGatewayPort,
    @Inject(CART_EVENTS_PUBLISHER)
    private readonly publisher: ICartEventsPublisherPort,
    @InjectPinoLogger(RemoveFromCartUseCase.name)
    private readonly logger: PinoLogger,
  ) {}

  public async execute(payload: IRetailCartRemoveLinePayload): Promise<CartView> {
    const { cartId, customerId, lineId, correlationId } = payload;

    this.logger.info({ correlationId, cartId, lineId }, 'Removing line from cart');

    const cart = await loadOwnedCart(this.repository, cartId, customerId);

    // Capture the line's `variantId` BEFORE `removeLine` drops it (the release
    // selector needs it). `removeLine` throws `CART_LINE_NOT_FOUND` when the line
    // is missing, so a failed lookup never reaches the release call below.
    const variantId = cart.lines.find((line) => line.id === lineId)?.variantId;
    cart.removeLine(lineId);

    const saved = await this.repository.save(cart);
    const occurredAt = (cart.pullDomainEvents()[0]?.occurredAt ?? new Date()).toISOString();

    // Best-effort release: the line is gone, so return its held units to
    // `available`. A failure here is warn-logged and swallowed — never fails the
    // remove (the over-hold is reclaimable via release/TTL).
    if (variantId !== undefined) {
      try {
        await this.inventory.releaseStock({
          cartId,
          variantId,
          reason: 'cart-removed',
          correlationId,
        });
      } catch (err) {
        this.logger.warn(
          { err: err as Error, correlationId, cartId, lineId, variantId },
          'Failed to release reservation for removed cart line (stock over-held until release/TTL)',
        );
      }
    }

    try {
      await this.publisher.publishCartLineRemoved({
        cartId,
        lineId,
        eventVersion: 'v1',
        occurredAt,
        correlationId,
      });
    } catch (err) {
      this.logger.warn(
        { err: err as Error, correlationId, cartId, lineId },
        'Failed to publish retail.cart.line-removed event',
      );
    }

    this.logger.info({ correlationId, cartId, lineId }, 'Line removed from cart');
    return toCartView(saved);
  }
}
