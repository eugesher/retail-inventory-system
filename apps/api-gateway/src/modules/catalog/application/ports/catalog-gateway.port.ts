import {
  CategoryReparentView,
  CategoryTreeNodeView,
  CategoryView,
  IPage,
  MediaAssetTypeEnum,
  MediaAssetView,
  MediaOwnerTypeEnum,
  PriceView,
  ProductCategoriesView,
  ProductVariantView,
  ProductView,
  ProductWithVariantsView,
  TaxCategoryView,
  VariantTaxHeaderView,
  VariantWithProductView,
} from '@retail-inventory-system/contracts';

export const CATALOG_GATEWAY_PORT = Symbol('CATALOG_GATEWAY_PORT');

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

export interface IPriceQueryRequest {
  variantId: number;
  currency?: string;
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

export interface ICreateCategoryCommand {
  name: string;
  slug: string;
  parentSlug?: string;
  sortOrder?: number;
}

export interface IReparentCategoryCommand {
  slug: string;
  newParentSlug?: string | null;
}

export interface IListCategoriesCommand {
  rootOnly?: boolean;
}

export interface ICategoryProductsCommand {
  slug: string;
  includeDescendants?: boolean;
  page?: number;
  pageSize?: number;
}

export interface IReclassifyProductCommand {
  productId: number;
  attachCategorySlugs: string[];
  detachCategorySlugs: string[];
}

export interface IAttachMediaCommand {
  ownerType: MediaOwnerTypeEnum;
  ownerId: number;
  uri: string;
  type: MediaAssetTypeEnum;
  altText?: string;
}

export interface IReorderMediaCommand {
  ownerType: MediaOwnerTypeEnum;
  ownerId: number;
  mediaIdsInOrder: number[];
}

export interface IListMediaCommand {
  ownerType: MediaOwnerTypeEnum;
  ownerId: number;
}

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
  createCategory(command: ICreateCategoryCommand, correlationId: string): Promise<CategoryView>;
  reparentCategory(
    command: IReparentCategoryCommand,
    correlationId: string,
  ): Promise<CategoryReparentView>;
  listCategories(query: IListCategoriesCommand, correlationId: string): Promise<CategoryView[]>;
  getCategoryTree(slug: string, correlationId: string): Promise<CategoryTreeNodeView>;
  listCategoryProducts(
    query: ICategoryProductsCommand,
    correlationId: string,
  ): Promise<IPage<ProductWithVariantsView>>;
  reclassifyProduct(
    command: IReclassifyProductCommand,
    correlationId: string,
  ): Promise<ProductCategoriesView>;
  attachMedia(command: IAttachMediaCommand, correlationId: string): Promise<MediaAssetView>;
  reorderMedia(command: IReorderMediaCommand, correlationId: string): Promise<MediaAssetView[]>;
  detachMedia(mediaId: number, correlationId: string): Promise<MediaAssetView>;
  listMedia(query: IListMediaCommand, correlationId: string): Promise<MediaAssetView[]>;
}
