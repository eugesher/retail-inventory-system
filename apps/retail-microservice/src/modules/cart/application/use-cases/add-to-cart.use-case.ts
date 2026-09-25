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
  OCC_RETRY_ATTEMPTS,
} from '../ports';
import { loadOwnedCart } from './cart-access';
import { toCartView } from './cart-view.factory';
import { assertCartVersion, runWithCartWriteRetry } from './cart-write';

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
    @Inject(OCC_RETRY_ATTEMPTS)
    private readonly maxAttempts: number,
    @InjectPinoLogger(AddToCartUseCase.name)
    private readonly logger: PinoLogger,
  ) {}

  public async execute(payload: IRetailCartAddLinePayload): Promise<CartView> {
    const { cartId, customerId, variantId, quantity, expectedVersion, correlationId } = payload;

    this.logger.info({ correlationId, cartId, variantId, quantity }, 'Adding line to cart');

    const { saved, occurredAt } = await runWithCartWriteRetry(
      { logger: this.logger, maxAttempts: expectedVersion !== undefined ? 1 : this.maxAttempts },
      async () => {
        const cart = await loadOwnedCart(this.repository, cartId, customerId);
        assertCartVersion(cart, expectedVersion);

        const price = await this.catalog.selectApplicablePrice(
          variantId,
          cart.currency,
          correlationId,
        );
        if (price === null) {
          throw new CartDomainException(
            CartErrorCodeEnum.CART_VARIANT_NOT_PRICED,
            `Variant ${variantId} has no applicable ${cart.currency} price; cannot add to cart`,
          );
        }

        const existing = cart.lines.find((line) => line.variantId === variantId);
        const targetQty = (existing?.quantity ?? 0) + quantity;
        await this.inventory.reserveStock({
          variantId,
          quantity: targetQty,
          cartId,
          correlationId,
        });

        const versionAtLoad = cart.version;
        cart.addLine({
          variantId,
          quantity,
          unitPriceSnapshotMinor: price.amountMinor,
          currencySnapshot: cart.currency,
        });

        const persisted = await this.repository.save(cart, versionAtLoad);
        const eventOccurredAt = (
          cart.pullDomainEvents()[0]?.occurredAt ?? new Date()
        ).toISOString();
        return { saved: persisted, occurredAt: eventOccurredAt };
      },
      { cartId, correlationId },
    );

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

    const savedLine = saved.lines.find((line) => line.variantId === variantId);
    this.logger.info(
      {
        correlationId,
        cartId,
        variantId,
        unitPriceSnapshotMinor: savedLine?.unitPriceSnapshotMinor,
      },
      'Line added to cart',
    );
    return toCartView(saved);
  }
}
