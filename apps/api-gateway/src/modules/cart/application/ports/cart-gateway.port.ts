import {
  CartView,
  IAddressInput,
  IIdempotentResult,
  OrderView,
} from '@retail-inventory-system/contracts';

export const CART_GATEWAY_PORT = Symbol('CART_GATEWAY_PORT');

export interface ICartCreateCommand {
  customerId: string;
  currency?: string;
}

export interface ICartGetQuery {
  cartId: string;
  customerId: string;
}

export interface ICartAddLineCommand {
  cartId: string;
  customerId: string;
  variantId: number;
  quantity: number;
  expectedVersion?: number;
}

export interface ICartChangeLineQuantityCommand {
  cartId: string;
  customerId: string;
  lineId: number;
  quantity: number;
  expectedVersion?: number;
}

export interface ICartRemoveLineCommand {
  cartId: string;
  customerId: string;
  lineId: number;
  expectedVersion?: number;
}

export interface ICartClaimCommand {
  cartId: string;
  fromCustomerId: string;
  newCustomerId: string;
}

export interface ICartPlaceCommand {
  cartId: string;
  customerId: string;
  shippingAddress: IAddressInput;
  billingAddress: IAddressInput;
  paymentMethod?: string;
  idempotencyKey?: string;
}

export interface ICartGatewayPort {
  createCart(command: ICartCreateCommand, correlationId: string): Promise<CartView>;
  getCart(query: ICartGetQuery, correlationId: string): Promise<CartView>;
  addLine(command: ICartAddLineCommand, correlationId: string): Promise<CartView>;
  changeLineQuantity(
    command: ICartChangeLineQuantityCommand,
    correlationId: string,
  ): Promise<CartView>;
  removeLine(command: ICartRemoveLineCommand, correlationId: string): Promise<CartView>;
  claim(command: ICartClaimCommand, correlationId: string): Promise<CartView>;
  placeOrder(
    command: ICartPlaceCommand,
    correlationId: string,
  ): Promise<IIdempotentResult<OrderView>>;
}
