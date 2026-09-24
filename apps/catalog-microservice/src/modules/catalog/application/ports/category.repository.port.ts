import { Category } from '../../domain';

export const CATEGORY_REPOSITORY = Symbol('CATEGORY_REPOSITORY');

export interface ICategoryListAllOptions {
  rootOnly?: boolean;
  activeOnly?: boolean;
}

export interface ICategorySubtreeOptions {
  activeOnly?: boolean;
}

export interface ICategoryRepositoryPort {
  save(category: Category): Promise<Category>;
  findBySlug(slug: string): Promise<Category | null>;
  existsBySlug(slug: string): Promise<boolean>;
  listAll(opts: ICategoryListAllOptions): Promise<Category[]>;
  listSubtree(pathPrefix: string, opts?: ICategorySubtreeOptions): Promise<Category[]>;
  reparentSubtree(category: Category, oldPath: string): Promise<number>;

  attachProductCategories(productId: number, categoryIds: number[]): Promise<void>;
  detachProductCategories(productId: number, categoryIds: number[]): Promise<void>;
  listCategoriesForProduct(productId: number): Promise<Category[]>;
}
