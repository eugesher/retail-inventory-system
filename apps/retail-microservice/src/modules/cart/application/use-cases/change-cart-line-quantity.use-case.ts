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
  OCC_RETRY_ATTEMPTS,
} from '../ports';
import { loadOwnedCart } from './cart-access';
import { toCartView } from './cart-view.factory';
import { assertCartVersion, runWithCartWriteRetry } from './cart-write';

@Injectable()
export class ChangeCartLineQuantityUseCase {
  constructor(
    @Inject(CART_REPOSITORY)
    private readonly repository: ICartRepositoryPort,
    @Inject(CART_INVENTORY_GATEWAY)
    private readonly inventory: ICartInventoryGatewayPort,
    @Inject(CART_EVENTS_PUBLISHER)
    private readonly publisher: ICartEventsPublisherPort,
    @Inject(OCC_RETRY_ATTEMPTS)
    private readonly maxAttempts: number,
    @InjectPinoLogger(ChangeCartLineQuantityUseCase.name)
    private readonly logger: PinoLogger,
  ) {}

  public async execute(payload: IRetailCartChangeLineQuantityPayload): Promise<CartView> {
    const { cartId, customerId, lineId, quantity, expectedVersion, correlationId } = payload;

    this.logger.info({ correlationId, cartId, lineId, quantity }, 'Changing cart line quantity');

    const { saved, occurredAt } = await runWithCartWriteRetry(
      { logger: this.logger, maxAttempts: expectedVersion !== undefined ? 1 : this.maxAttempts },
      async () => {
        const cart = await loadOwnedCart(this.repository, cartId, customerId);
        assertCartVersion(cart, expectedVersion);

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

        const versionAtLoad = cart.version;
        cart.changeLineQuantity(lineId, quantity);

        const persisted = await this.repository.save(cart, versionAtLoad);
        const eventOccurredAt = (
          cart.pullDomainEvents()[0]?.occurredAt ?? new Date()
        ).toISOString();
        return { saved: persisted, occurredAt: eventOccurredAt };
      },
      { cartId, correlationId },
    );

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
