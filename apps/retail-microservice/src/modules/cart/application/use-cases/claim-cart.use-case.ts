import { Inject, Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';

import { CartView, IRetailCartClaimPayload } from '@retail-inventory-system/contracts';

import { CartDomainException, CartErrorCodeEnum } from '../../domain';
import { CART_REPOSITORY, ICartRepositoryPort } from '../ports';
import { loadOwnedCart } from './cart-access';
import { toCartView } from './cart-view.factory';

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

    await loadOwnedCart(this.repository, cartId, fromCustomerId);

    await this.repository.reassignCustomer(cartId, newCustomerId);

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
