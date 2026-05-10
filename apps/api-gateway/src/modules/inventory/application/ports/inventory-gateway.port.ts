import { ProductStockGetResponseDto } from '@retail-inventory-system/contracts';

export const INVENTORY_GATEWAY_PORT = Symbol('INVENTORY_GATEWAY_PORT');

export interface IGetProductStockQuery {
  productId: number;
  storageIds?: string[];
}

export interface IInventoryGatewayPort {
  getProductStock(
    query: IGetProductStockQuery,
    correlationId: string,
  ): Promise<ProductStockGetResponseDto>;
}
