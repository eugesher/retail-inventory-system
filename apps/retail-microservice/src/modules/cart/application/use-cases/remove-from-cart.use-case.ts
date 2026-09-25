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

    const { saved, occurredAt, variantId } = await runWithCartWriteRetry(
      { logger: this.logger, maxAttempts: expectedVersion !== undefined ? 1 : this.maxAttempts },
      async () => {
        const cart = await loadOwnedCart(this.repository, cartId, customerId);
        assertCartVersion(cart, expectedVersion);

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
