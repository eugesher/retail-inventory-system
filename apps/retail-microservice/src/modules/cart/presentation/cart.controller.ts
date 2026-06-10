import { Controller } from '@nestjs/common';
import { MessagePattern, Payload } from '@nestjs/microservices';

import {
  CartView,
  IRetailCartAddLinePayload,
  IRetailCartChangeLineQuantityPayload,
  IRetailCartClaimPayload,
  IRetailCartCreatePayload,
  IRetailCartGetPayload,
  IRetailCartRemoveLinePayload,
} from '@retail-inventory-system/contracts';
import { ROUTING_KEYS } from '@retail-inventory-system/messaging';

import {
  AddToCartUseCase,
  ChangeCartLineQuantityUseCase,
  ClaimCartUseCase,
  CreateCartUseCase,
  GetCartUseCase,
  RemoveFromCartUseCase,
} from '../application/use-cases';

// RPC surface for the cart operations (API Gateway → Retail over `retail_queue`).
// Each handler is a thin delegate to its use case; a `CartDomainException` is
// terminated by the `CartRpcExceptionFilter` into the `{ statusCode, ... }` wire
// shape the gateway maps. Every use case returns the `CartView` the gateway
// surfaces unchanged.
@Controller()
export class CartController {
  constructor(
    private readonly createCart: CreateCartUseCase,
    private readonly getCart: GetCartUseCase,
    private readonly addToCart: AddToCartUseCase,
    private readonly changeCartLineQuantity: ChangeCartLineQuantityUseCase,
    private readonly removeFromCart: RemoveFromCartUseCase,
    private readonly claimCart: ClaimCartUseCase,
  ) {}

  @MessagePattern(ROUTING_KEYS.RETAIL_CART_CREATE)
  public handleCreate(@Payload() payload: IRetailCartCreatePayload): Promise<CartView> {
    return this.createCart.execute(payload);
  }

  @MessagePattern(ROUTING_KEYS.RETAIL_CART_GET)
  public handleGet(@Payload() payload: IRetailCartGetPayload): Promise<CartView> {
    return this.getCart.execute(payload);
  }

  @MessagePattern(ROUTING_KEYS.RETAIL_CART_ADD_LINE)
  public handleAddLine(@Payload() payload: IRetailCartAddLinePayload): Promise<CartView> {
    return this.addToCart.execute(payload);
  }

  @MessagePattern(ROUTING_KEYS.RETAIL_CART_CHANGE_LINE_QUANTITY)
  public handleChangeLineQuantity(
    @Payload() payload: IRetailCartChangeLineQuantityPayload,
  ): Promise<CartView> {
    return this.changeCartLineQuantity.execute(payload);
  }

  @MessagePattern(ROUTING_KEYS.RETAIL_CART_REMOVE_LINE)
  public handleRemoveLine(@Payload() payload: IRetailCartRemoveLinePayload): Promise<CartView> {
    return this.removeFromCart.execute(payload);
  }

  @MessagePattern(ROUTING_KEYS.RETAIL_CART_CLAIM)
  public handleClaim(@Payload() payload: IRetailCartClaimPayload): Promise<CartView> {
    return this.claimCart.execute(payload);
  }
}
