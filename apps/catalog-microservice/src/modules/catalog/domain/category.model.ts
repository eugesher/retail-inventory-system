import { AggregateRoot } from '@retail-inventory-system/ddd';

import { CatalogDomainException, CatalogErrorCodeEnum } from './catalog.exception';
import { CategoryStatusEnum } from './category-status.enum';

const SLUG_REGEX = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export interface ICategoryProps {
  id: number | null;
  name: string;
  slug: string;
  parentId: number | null;
  path: string;
  sortOrder: number;
  status: CategoryStatusEnum;
  createdAt?: Date | null;
  updatedAt?: Date | null;
}

export interface ICreateCategoryInput {
  name: string;
  slug: string;
  parent?: Category | null;
  sortOrder?: number;
}

export class Category extends AggregateRoot<number | null> {
  private readonly _name: string;
  private readonly _slug: string;
  private _parentId: number | null;
  private _path: string;
  private readonly _sortOrder: number;
  private _status: CategoryStatusEnum;
  public readonly createdAt: Date | null;
  public readonly updatedAt: Date | null;

  private constructor(props: ICategoryProps) {
    if (typeof props.name !== 'string' || props.name.trim().length === 0) {
      throw new CatalogDomainException(
        CatalogErrorCodeEnum.CATEGORY_NAME_REQUIRED,
        'Category.name must be a non-empty string',
      );
    }
    if (typeof props.slug !== 'string' || !SLUG_REGEX.test(props.slug)) {
      throw new CatalogDomainException(
        CatalogErrorCodeEnum.CATEGORY_SLUG_INVALID,
        `Category.slug must be kebab-case (${SLUG_REGEX.source})`,
      );
    }
    if (!Number.isInteger(props.sortOrder) || props.sortOrder < 0) {
      throw new CatalogDomainException(
        CatalogErrorCodeEnum.CATEGORY_SORT_ORDER_INVALID,
        'Category.sortOrder must be a non-negative integer',
      );
    }

    super(props.id);
    this._name = props.name;
    this._slug = props.slug;
    this._parentId = props.parentId;
    this._path = props.path;
    this._sortOrder = props.sortOrder;
    this._status = props.status;
    this.createdAt = props.createdAt ?? null;
    this.updatedAt = props.updatedAt ?? null;
  }

  public static create(input: ICreateCategoryInput): Category {
    const parent = input.parent ?? null;
    return new Category({
      id: null,
      name: input.name,
      slug: input.slug,
      parentId: parent ? parent.id : null,
      path: Category.derivePath(parent, input.slug),
      sortOrder: input.sortOrder ?? 0,
      status: CategoryStatusEnum.ACTIVE,
    });
  }

  public static reconstitute(props: ICategoryProps): Category {
    return new Category(props);
  }

  public get name(): string {
    return this._name;
  }

  public get slug(): string {
    return this._slug;
  }

  public get parentId(): number | null {
    return this._parentId;
  }

  public get path(): string {
    return this._path;
  }

  public get sortOrder(): number {
    return this._sortOrder;
  }

  public get status(): CategoryStatusEnum {
    return this._status;
  }

  public isActive(): boolean {
    return this._status === CategoryStatusEnum.ACTIVE;
  }

  public isArchived(): boolean {
    return this._status === CategoryStatusEnum.ARCHIVED;
  }

  public isAncestorOfOrSelf(other: Category): boolean {
    return other.path === this._path || other.path.startsWith(`${this._path}/`);
  }

  public reparentUnder(newParent: Category | null): void {
    if (newParent !== null && this.isAncestorOfOrSelf(newParent)) {
      throw new CatalogDomainException(
        CatalogErrorCodeEnum.CATEGORY_CYCLE,
        'Category.reparentUnder: cannot reparent a category under itself or one of its descendants',
      );
    }

    this._parentId = newParent ? newParent.id : null;
    this._path = Category.derivePath(newParent, this._slug);
  }

  public archive(): void {
    if (!this.isActive()) {
      throw new CatalogDomainException(
        CatalogErrorCodeEnum.CATEGORY_INVALID_STATE_TRANSITION,
        `Category.archive: only an active category can be archived (current status: ${this._status})`,
      );
    }
    this._status = CategoryStatusEnum.ARCHIVED;
  }

  private static derivePath(parent: Category | null, slug: string): string {
    return parent ? `${parent.path}/${slug}` : `/${slug}`;
  }
}
