import { Inject, Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';

import { CartView, IRetailCartCreatePayload } from '@retail-inventory-system/contracts';

import { Cart } from '../../domain';
import {
  CART_EVENTS_PUBLISHER,
  CART_REPOSITORY,
  ICartEventsPublisherPort,
  ICartRepositoryPort,
  RETAIL_DEFAULT_CURRENCY,
} from '../ports';
import { toCartView } from './cart-view.factory';

@Injectable()
export class CreateCartUseCase {
  constructor(
    @Inject(CART_REPOSITORY)
    private readonly repository: ICartRepositoryPort,
    @Inject(CART_EVENTS_PUBLISHER)
    private readonly publisher: ICartEventsPublisherPort,
    @Inject(RETAIL_DEFAULT_CURRENCY)
    private readonly defaultCurrency: string,
    @InjectPinoLogger(CreateCartUseCase.name)
    private readonly logger: PinoLogger,
  ) {}

  public async execute(payload: IRetailCartCreatePayload): Promise<CartView> {
    const { customerId, currency, correlationId } = payload;
    const resolvedCurrency = currency ?? this.defaultCurrency;

    this.logger.info({ correlationId, customerId, currency: resolvedCurrency }, 'Creating cart');

    const cart = Cart.create({ customerId, currency: resolvedCurrency });
    const saved = await this.repository.save(cart);
    const cartId = saved.id!;

    const occurredAt = (cart.pullDomainEvents()[0]?.occurredAt ?? new Date()).toISOString();

    try {
      await this.publisher.publishCartCreated({
        cartId,
        customerId: saved.customerId,
        currency: saved.currency,
        eventVersion: 'v1',
        occurredAt,
        correlationId,
      });
    } catch (err) {
      this.logger.warn(
        { err: err as Error, correlationId, cartId },
        'Failed to publish retail.cart.created event',
      );
    }

    this.logger.info({ correlationId, cartId }, 'Cart created');
    return toCartView(saved);
  }
}
