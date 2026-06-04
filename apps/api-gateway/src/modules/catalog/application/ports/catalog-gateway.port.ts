import {
  IPage,
  PriceView,
  ProductVariantView,
  ProductView,
  ProductWithVariantsView,
  TaxCategoryView,
  VariantTaxHeaderView,
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

// Pricing/tax command + query inputs. `variantId` is resolved from the route
// param (the downstream backbone key, ADR-025) and folded into the command in
// the controller, the same split `ICreateVariantCommand` follows for
// `productId`. Timestamps are ISO-8601 strings on the wire; `amountMinor` is an
// integer count of minor units (cents). The pricing domain has the final say on
// every invariant — these shapes are the gateway's edge contract.
export interface ISetPriceCommand {
  variantId: number;
  currency: string;
  amountMinor: number;
  validFrom?: string;
  validTo?: string | null;
  priority?: number;
}

export interface IPriceQueryCommand {
  variantId: number;
  currency: string;
  asOf?: string;
}

export interface ICreateTaxCategoryCommand {
  code: string;
  name: string;
  description?: string;
}

export interface IAttachVariantTaxCategoryCommand {
  variantId: number;
  taxCategoryCode: string;
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
  setPrice(command: ISetPriceCommand, correlationId: string): Promise<PriceView>;
  listPrices(query: IPriceQueryCommand, correlationId: string): Promise<PriceView[]>;
  // The catalog `catalog.price.select` RPC resolves to a single Price or `null`
  // when none is in effect for the `(variantId, currency)` scope at `asOf`; the
  // gateway surfaces that `null` unchanged (the route returns `200` with a
  // `null` body — see `CatalogController.getApplicablePrice`).
  getApplicablePrice(query: IPriceQueryCommand, correlationId: string): Promise<PriceView | null>;
  createTaxCategory(
    command: ICreateTaxCategoryCommand,
    correlationId: string,
  ): Promise<TaxCategoryView>;
  listTaxCategories(correlationId: string): Promise<TaxCategoryView[]>;
  attachVariantTaxCategory(
    command: IAttachVariantTaxCategoryCommand,
    correlationId: string,
  ): Promise<VariantTaxHeaderView>;
}
