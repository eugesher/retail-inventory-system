import { ICorrelationPayload } from '@retail-inventory-system/common';
import { ProductStock } from '../../../entities';

export interface IProductStockCommonAddItem extends Pick<
  ProductStock,
  'productId' | 'actionId' | 'quantity'
> {
  storageId?: ProductStock['storageId'];
  orderProductId?: ProductStock['orderProductId'];
}

export interface IProductStockCommonAdd extends ICorrelationPayload {
  items: IProductStockCommonAddItem[];
}
