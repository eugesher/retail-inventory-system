import { Module } from '@nestjs/common';

import { MicroserviceClientRetailModule } from '@retail-inventory-system/messaging';

import { CART_GATEWAY_PORT } from './application/ports';
import {
  AddToCartUseCase,
  ChangeCartLineQuantityUseCase,
  ClaimCartUseCase,
  CreateCartUseCase,
  GetCartUseCase,
  RemoveFromCartUseCase,
} from './application/use-cases';
import { CartRabbitmqAdapter } from './infrastructure/messaging';
import { CartController } from './presentation';

// Gateway-side port→adapter module fronting the retail microservice's six cart
// RPCs over HTTP at `/api/cart` (ADR-009). Named after the downstream service.
// `CartRabbitmqAdapter` (the sole `ClientProxy` holder) backs `CART_GATEWAY_PORT`;
// the use cases and controller depend on the port symbol only. The gateway holds
// no cart state of its own — `MicroserviceClientRetailModule` provides the
// `RETAIL_MICROSERVICE` client that targets `retail_queue`.
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
    { provide: CART_GATEWAY_PORT, useClass: CartRabbitmqAdapter },
  ],
})
export class CartModule {}
