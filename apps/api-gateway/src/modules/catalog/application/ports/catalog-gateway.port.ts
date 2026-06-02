import {
  IPage,
  ProductVariantView,
  ProductView,
  ProductWithVariantsView,
  VariantWithProductView,
} from '@retail-inventory-system/contracts';

export const CATALOG_GATEWAY_PORT = Symbol('CATALOG_GATEWAY_PORT');

// Business-shaped command/query inputs for the gateway catalog port. They
// deliberately omit `correlationId` — that is a transport concern threaded
// separately and stitched onto the wire payload inside the adapter (the same
// split `IGetProductStockQuery` follows in the inventory gateway module).
export interface IRegisterProductCommand {
  name: string;
  slug: string;
  description?: string;
}

export interface ICreateVariantCommand {
  productId: number;
  sku: string;
  gtin?: string;
  optionValues: Record<string, string>;
  weightG?: number;
  dimensionsMm?: { l: number; w: number; h: number };
}

export interface IListProductsCommand {
  status?: 'active' | 'draft' | 'archived';
  page?: number;
  pageSize?: number;
  search?: string;
}

// The gateway-side seam onto the catalog microservice's seven RPCs. The
// concrete implementation (`CatalogRabbitmqAdapter`) is the only holder of a
// `ClientProxy`; use cases and the controller depend on this interface
// (ADR-009). Methods return the wire response DTOs from `lib-contracts` so the
// HTTP layer surfaces the catalog's own view shapes unchanged.
export interface ICatalogGatewayPort {
  registerProduct(command: IRegisterProductCommand, correlationId: string): Promise<ProductView>;
  createVariant(command: ICreateVariantCommand, correlationId: string): Promise<ProductVariantView>;
  publishProduct(productId: number, correlationId: string): Promise<ProductView>;
  archiveProduct(productId: number, correlationId: string): Promise<ProductView>;
  listProducts(
    query: IListProductsCommand,
    correlationId: string,
  ): Promise<IPage<ProductWithVariantsView>>;
  getProductBySlug(slug: string, correlationId: string): Promise<ProductWithVariantsView>;
  getVariant(variantId: number, correlationId: string): Promise<VariantWithProductView>;
}
