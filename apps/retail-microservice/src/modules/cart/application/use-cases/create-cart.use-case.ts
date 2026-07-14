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

// Opens a new active cart for the caller. `customerId` is the resolved caller (a
// registered or guest customer — Q7: every cart has a Customer row). After persistence
// the use case drains the in-process `CartCreatedEvent` and emits the reserved
// `retail.cart.created` wire event (best-effort post-commit, ADR-020).
//
// **The currency default is CONFIGURED, not literal** (`RETAIL_DEFAULT_CURRENCY` ←
// `DEFAULT_CURRENCY`, the same env var catalog reads). It used to be a file-local
// `const DEFAULT_CURRENCY = 'USD'`, which meant an operator who set `DEFAULT_CURRENCY=EUR`
// got a catalog quoting EUR and carts still opening in USD — and since `Cart.currency` is
// immutable (ADR-028 §1) and the order snapshots it at place-time, the wrong unit was
// baked into the order and the payment with nothing downstream able to notice.
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

    // The drained event carries the moment the cart was opened; the re-read
    // `saved` aggregate has no events (reconstitute records none), so pull from
    // the original in-memory aggregate.
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
      // Best-effort: the cart is already committed — a publish failure never
      // fails the operation (ADR-020).
      this.logger.warn(
        { err: err as Error, correlationId, cartId },
        'Failed to publish retail.cart.created event',
      );
    }

    this.logger.info({ correlationId, cartId }, 'Cart created');
    return toCartView(saved);
  }
}
