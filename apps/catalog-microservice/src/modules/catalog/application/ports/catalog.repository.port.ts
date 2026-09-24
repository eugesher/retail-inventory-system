import { Product, ProductVariant } from '../../domain';

export const CATALOG_REPOSITORY = Symbol('CATALOG_REPOSITORY');

export interface ICatalogListActiveQuery {
  page: number;
  size: number;
  search?: string;
}

export interface ICatalogListByCategoryQuery {
  categoryIds: number[];
  page: number;
  size: number;
}

export interface IProductPage {
  items: Product[];
  total: number;
  page: number;
  size: number;
}

export interface ICatalogRepositoryPort {
  save(product: Product): Promise<Product>;
  findById(id: number): Promise<Product | null>;
  findBySlug(slug: string): Promise<Product | null>;
  existsBySlug(slug: string): Promise<boolean>;
  existsBySku(sku: string): Promise<boolean>;
  findVariantById(variantId: number): Promise<ProductVariant | null>;
  listActive(query: ICatalogListActiveQuery): Promise<IProductPage>;
  listActiveByCategoryIds(query: ICatalogListByCategoryQuery): Promise<IProductPage>;
}
