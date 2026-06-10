import { Controller } from '@nestjs/common';
import { MessagePattern, Payload } from '@nestjs/microservices';

import { IPlaceOrderPayload, OrderView } from '@retail-inventory-system/contracts';
import { ROUTING_KEYS } from '@retail-inventory-system/messaging';

import { PlaceOrderUseCase } from '../application/use-cases';

// RPC surface for the order operations (API Gateway → Retail over `retail_queue`).
// `retail.cart.place` is a cart-shaped key (it acts on a cart) served here in the
// orders controller, because the operation produces an immutable `Order` (ADR-028
// §1). The handler is a thin delegate; an `OrderDomainException` is terminated by the
// `OrdersRpcExceptionFilter` into the `{ statusCode, ... }` wire shape the gateway
// maps. Get / List / Capture handlers arrive with the read/capture capability.
@Controller()
export class OrdersController {
  constructor(private readonly placeOrder: PlaceOrderUseCase) {}

  @MessagePattern(ROUTING_KEYS.RETAIL_CART_PLACE)
  public handlePlace(@Payload() payload: IPlaceOrderPayload): Promise<OrderView> {
    return this.placeOrder.execute(payload);
  }
}
