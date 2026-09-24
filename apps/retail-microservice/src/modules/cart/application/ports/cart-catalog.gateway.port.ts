import { PriceView } from '@retail-inventory-system/contracts';

export const CART_CATALOG_GATEWAY = Symbol('CART_CATALOG_GATEWAY');

export interface ICartCatalogGatewayPort {
  selectApplicablePrice(
    variantId: number,
    currency: string,
    correlationId?: string,
  ): Promise<PriceView | null>;
}
