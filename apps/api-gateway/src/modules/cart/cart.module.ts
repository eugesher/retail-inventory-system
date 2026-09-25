import { Module } from '@nestjs/common';

import { MicroserviceClientRetailModule } from '@retail-inventory-system/messaging';

import { CART_GATEWAY_PORT } from './application/ports';
import {
  AddToCartUseCase,
  ChangeCartLineQuantityUseCase,
  ClaimCartUseCase,
  CreateCartUseCase,
  GetCartUseCase,
  PlaceCartOrderUseCase,
  RemoveFromCartUseCase,
} from './application/use-cases';
import { CartRabbitmqAdapter } from './infrastructure/messaging';
import { CartController } from './presentation';

@Module({
  imports: [MicroserviceClientRetailModule],
  controllers: [CartController],
  providers: [
    CreateCartUseCase,
    GetCartUseCase,
    AddToCartUseCase,
    ChangeCartLineQuantityUseCase,
    RemoveFromCartUseCase,
    ClaimCartUseCase,
    PlaceCartOrderUseCase,
    { provide: CART_GATEWAY_PORT, useClass: CartRabbitmqAdapter },
  ],
})
export class CartModule {}
