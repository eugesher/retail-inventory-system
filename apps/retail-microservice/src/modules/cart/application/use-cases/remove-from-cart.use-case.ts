import { Inject, Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';

import { CartView, IRetailCartRemoveLinePayload } from '@retail-inventory-system/contracts';

import {
  CART_EVENTS_PUBLISHER,
  CART_REPOSITORY,
  ICartEventsPublisherPort,
  ICartRepositoryPort,
} from '../ports';
import { loadOwnedCart } from './cart-access';
import { toCartView } from './cart-view.factory';

// Drops a line from the cart. An unknown line id is a 404
// (`CART_LINE_NOT_FOUND`). The repository reconciles the removed row away inside
// the save transaction. After save the use case emits the reserved
// `retail.cart.line-removed` wire event (best-effort post-commit).
@Injectable()
export class RemoveFromCartUseCase {
  constructor(
    @Inject(CART_REPOSITORY)
    private readonly repository: ICartRepositoryPort,
    @Inject(CART_EVENTS_PUBLISHER)
    private readonly publisher: ICartEventsPublisherPort,
    @InjectPinoLogger(RemoveFromCartUseCase.name)
    private readonly logger: PinoLogger,
  ) {}

  public async execute(payload: IRetailCartRemoveLinePayload): Promise<CartView> {
    const { cartId, customerId, lineId, correlationId } = payload;

    this.logger.info({ correlationId, cartId, lineId }, 'Removing line from cart');

    const cart = await loadOwnedCart(this.repository, cartId, customerId);
    cart.removeLine(lineId);

    const saved = await this.repository.save(cart);
    const occurredAt = (cart.pullDomainEvents()[0]?.occurredAt ?? new Date()).toISOString();

    try {
      await this.publisher.publishCartLineRemoved(
        { cartId, lineId, eventVersion: 'v1', occurredAt, correlationId },
        correlationId,
      );
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
