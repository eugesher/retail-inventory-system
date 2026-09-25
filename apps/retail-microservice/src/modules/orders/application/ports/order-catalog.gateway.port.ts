import { PriceView, VariantWithProductView } from '@retail-inventory-system/contracts';

export const ORDER_CATALOG_GATEWAY = Symbol('ORDER_CATALOG_GATEWAY');

export interface IOrderCatalogGatewayPort {
  getVariant(variantId: number, correlationId?: string): Promise<VariantWithProductView>;
  selectApplicablePrice(
    variantId: number,
    currency: string,
    correlationId?: string,
  ): Promise<PriceView | null>;
}
