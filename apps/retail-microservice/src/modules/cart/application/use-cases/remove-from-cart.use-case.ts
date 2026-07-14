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
  OCC_RETRY_ATTEMPTS,
} from '../ports';
import { loadOwnedCart } from './cart-access';
import { toCartView } from './cart-view.factory';
import { assertCartVersion, runWithCartWriteRetry } from './cart-write';

// Drops a line from the cart. An unknown line id is a 404
// (`CART_LINE_NOT_FOUND`). The repository reconciles the removed row away inside
// the save transaction. After a successful save the use case releases the line's
// stock hold against the inventory reservation surface (ADR-030) — **best-effort**
// (try/warn/swallow): the cart write is the primary outcome, so a failed release
// (which merely over-holds stock until the reservation's TTL lapses and the inventory sweeper
// releases it — ADR-038) never fails the remove. After save the use case also emits the
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
    @Inject(OCC_RETRY_ATTEMPTS)
    private readonly maxAttempts: number,
    @InjectPinoLogger(RemoveFromCartUseCase.name)
    private readonly logger: PinoLogger,
  ) {}

  public async execute(payload: IRetailCartRemoveLinePayload): Promise<CartView> {
    const { cartId, customerId, lineId, expectedVersion, correlationId } = payload;

    this.logger.info({ correlationId, cartId, lineId }, 'Removing line from cart');

    // OCC (ADR-036): read-version → mutate → version-checked persist, inside the
    // bounded retry (single attempt when the client pinned `If-Match`). The
    // best-effort release runs AFTER the confirmed removal, outside the loop, so a
    // retried attempt never double-releases.
    const { saved, occurredAt, variantId } = await runWithCartWriteRetry(
      { logger: this.logger, maxAttempts: expectedVersion !== undefined ? 1 : this.maxAttempts },
      async () => {
        const cart = await loadOwnedCart(this.repository, cartId, customerId);
        assertCartVersion(cart, expectedVersion);

        // Capture the line's `variantId` BEFORE `removeLine` drops it (the release
        // selector needs it). `removeLine` throws `CART_LINE_NOT_FOUND` when the
        // line is missing, so a failed lookup never reaches the release below.
        const removedVariantId = cart.lines.find((line) => line.id === lineId)?.variantId;
        const versionAtLoad = cart.version;
        cart.removeLine(lineId);

        const persisted = await this.repository.save(cart, versionAtLoad);
        const eventOccurredAt = (
          cart.pullDomainEvents()[0]?.occurredAt ?? new Date()
        ).toISOString();
        return { saved: persisted, occurredAt: eventOccurredAt, variantId: removedVariantId };
      },
      { cartId, correlationId },
    );

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
