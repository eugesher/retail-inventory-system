import { AggregateRoot } from '@retail-inventory-system/ddd';

import { CatalogDomainException, CatalogErrorCodeEnum } from './catalog.exception';
import { CategoryStatusEnum } from './category-status.enum';

// Kebab-case: lowercase alphanumerics in `-`-separated segments, no leading or
// trailing `-`, no doubled `--`. RE-DECLARED here rather than imported from the
// gateway DTO because the domain imports nothing from the gateway (ADR-004 /
// ADR-017) — the gateway's `register-product.request.dto.ts` carries the
// identical literal. This rule is STRICTER than `Product.slug` (which only
// requires non-empty): a category slug is a materialized-path segment, so a
// malformed slug (a space, a slash, uppercase) would corrupt every descendant's
// `path` (ADR-029).
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

// `create` takes the human-supplied fields plus the optional in-memory parent
// aggregate (not its id) — the factory reads `parent.path` to derive the child
// path, so the caller must load the parent first.
export interface ICreateCategoryInput {
  name: string;
  slug: string;
  parent?: Category | null;
  sortOrder?: number;
}

// Category is a catalog write aggregate (a sibling of `Product`, inside the same
// module — not a new bounded context, ADR-029 / ADR-004). It models a node in a
// hierarchy using a MATERIALIZED PATH: each row stores its full root-to-self
// slug path (`/electronics/phones`), so a subtree read is a single
// `path LIKE '/electronics/phones%'` rather than a recursive walk.
//
// The `number | null` id mirrors `Product`: null before persistence assigns one,
// concrete after `reconstitute`.
//
// Records NO domain events. Category edits are not in the must-emit set, so
// unlike `Product` this aggregate never calls `addDomainEvent`; `pullDomainEvents()`
// always drains empty (ADR-029 §6). A future cache-invalidation event would be
// additive.
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

  // Creates a new `active` category. `parentId` and `path` are DERIVED from the
  // optional parent: a null/absent parent is a root (`path = '/' + slug`),
  // otherwise the child hangs off the parent's path (`path = parent.path + '/' +
  // slug`). Records no event.
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

  // Rebuilds a persisted category from storage. The stored `path` is loaded
  // as-is (no re-derivation) and there is no status guard — any status
  // reconstitutes, including `archived`.
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

  // Pure prefix-ancestry test. `true` when `other` IS this category (same path)
  // or sits strictly below it (its path starts with `this.path + '/'`). The
  // trailing `'/'` is what makes `/a` NOT an ancestor of `/ab` — the boundary
  // matters, otherwise sibling prefixes would falsely register as ancestors.
  // This is the cycle test `reparentUnder` (and the reparent use case) calls.
  public isAncestorOfOrSelf(other: Category): boolean {
    return other.path === this._path || other.path.startsWith(`${this._path}/`);
  }

  // Recomputes THIS category's own `parentId` + `path` from the new parent
  // (a null parent demotes it to a root). Rejects a cycle: you cannot reparent a
  // category under itself or under any of its own descendants — caught by the
  // path-prefix test before any state mutation.
  //
  // The DESCENDANTS' path rewrite is deliberately NOT done here: each category
  // row is its own aggregate, so rebasing the subtree is a repository-transaction
  // concern (`ICategoryRepositoryPort.reparentSubtree`). The caller snapshots the
  // old `path` before calling this, then hands the mutated aggregate + the old
  // path to the repository (ADR-029 §2).
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

  // active → archived status flip (soft-delete via `status`; no `deletedAt`).
  // Archival is terminal — archiving an already-archived category is an illegal
  // transition. No producer ships in this capability (there is no archive
  // endpoint); the mutator exists because the soft-delete lifecycle is
  // status-driven (ADR-025) and the seed/tests may exercise it.
  public archive(): void {
    if (!this.isActive()) {
      throw new CatalogDomainException(
        CatalogErrorCodeEnum.CATEGORY_INVALID_STATE_TRANSITION,
        `Category.archive: only an active category can be archived (current status: ${this._status})`,
      );
    }
    this._status = CategoryStatusEnum.ARCHIVED;
  }

  // A path is `/` + the slugs from root to self joined by `/`. A root has no
  // parent, so its path is just `/<slug>`; a child appends `/<slug>` to the
  // parent's already-materialized path.
  private static derivePath(parent: Category | null, slug: string): string {
    return parent ? `${parent.path}/${slug}` : `/${slug}`;
  }
}
