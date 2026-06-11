import { Inject, Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';

import { CartView, IRetailCartChangeLineQuantityPayload } from '@retail-inventory-system/contracts';

import {
  CART_EVENTS_PUBLISHER,
  CART_REPOSITORY,
  ICartEventsPublisherPort,
  ICartRepositoryPort,
} from '../ports';
import { loadOwnedCart } from './cart-access';
import { toCartView } from './cart-view.factory';

// Sets a cart line's quantity to a new positive value. A `0` is rejected at the
// domain (`CART_LINE_QUANTITY_INVALID`) — removal is the explicit op; an unknown
// line id is a 404 (`CART_LINE_NOT_FOUND`). After save the use case emits the
// reserved `retail.cart.line-quantity-changed` wire event (best-effort
// post-commit).
@Injectable()
export class ChangeCartLineQuantityUseCase {
  constructor(
    @Inject(CART_REPOSITORY)
    private readonly repository: ICartRepositoryPort,
    @Inject(CART_EVENTS_PUBLISHER)
    private readonly publisher: ICartEventsPublisherPort,
    @InjectPinoLogger(ChangeCartLineQuantityUseCase.name)
    private readonly logger: PinoLogger,
  ) {}

  public async execute(payload: IRetailCartChangeLineQuantityPayload): Promise<CartView> {
    const { cartId, customerId, lineId, quantity, correlationId } = payload;

    this.logger.info({ correlationId, cartId, lineId, quantity }, 'Changing cart line quantity');

    const cart = await loadOwnedCart(this.repository, cartId, customerId);
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
