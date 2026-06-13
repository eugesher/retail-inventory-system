import { Inject, Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';

import { CartView, IRetailCartClaimPayload } from '@retail-inventory-system/contracts';

import { CartDomainException, CartErrorCodeEnum } from '../../domain';
import { CART_REPOSITORY, ICartRepositoryPort } from '../ports';
import { loadOwnedCart } from './cart-access';
import { toCartView } from './cart-view.factory';

// Promotes a guest cart to a registered customer (Q1/Q7). The re-point happens
// only if `cart.customerId === fromCustomerId` — knowing the guest id (handed
// back by the guest-session response) is the ownership proof, so the guard is the
// same `loadOwnedCart` the read/write use cases use, with `fromCustomerId` as the
// owner. A missing cart is a 404; a wrong `fromCustomerId` is a 403. On success
// the cart's `customerId` is reassigned to the registered customer and the
// updated view is returned.
//
// No inventory call: reservations key on `cartId`, which a claim re-points the
// owner of but never changes, so the holds survive guest-cart promotion untouched
// (ADR-030). Reserve/release are tied to the cart id, not the customer id.
@Injectable()
export class ClaimCartUseCase {
  constructor(
    @Inject(CART_REPOSITORY)
    private readonly repository: ICartRepositoryPort,
    @InjectPinoLogger(ClaimCartUseCase.name)
    private readonly logger: PinoLogger,
  ) {}

  public async execute(payload: IRetailCartClaimPayload): Promise<CartView> {
    const { cartId, fromCustomerId, newCustomerId, correlationId } = payload;

    this.logger.info(
      { correlationId, cartId, fromCustomerId, newCustomerId },
      'Claiming guest cart',
    );

    // The ownership proof: the cart must currently belong to `fromCustomerId`.
    await loadOwnedCart(this.repository, cartId, fromCustomerId);

    await this.repository.reassignCustomer(cartId, newCustomerId);

    // Re-read so the returned view reflects the new owner (and the version the
    // reassign UPDATE advanced).
    const reassigned = await this.repository.findById(cartId);
    if (reassigned === null) {
      throw new CartDomainException(
        CartErrorCodeEnum.CART_NOT_FOUND,
        `Cart ${cartId} vanished after reassign`,
      );
    }

    this.logger.info({ correlationId, cartId, newCustomerId }, 'Guest cart claimed');
    return toCartView(reassigned);
  }
}
