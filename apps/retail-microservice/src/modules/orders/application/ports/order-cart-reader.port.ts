import { CartStatusEnum } from '@retail-inventory-system/contracts';

import { ITransactionScope } from '@retail-inventory-system/ddd';

export const ORDER_CART_READER = Symbol('ORDER_CART_READER');

export interface IOrderCartSnapshot {
  cartId: string;
  customerId: string | null;
  currency: string;
  status: CartStatusEnum;
  lines: { variantId: number; quantity: number }[];
}

export interface IOrderCartReaderPort {
  findCart(cartId: string): Promise<IOrderCartSnapshot | null>;
  markConverted(cartId: string, scope?: ITransactionScope): Promise<boolean>;
}
