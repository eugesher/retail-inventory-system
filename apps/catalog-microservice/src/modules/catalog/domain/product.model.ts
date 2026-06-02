import { AggregateRoot } from '@retail-inventory-system/ddd';

import { CatalogDomainException, CatalogErrorCodeEnum } from './catalog.exception';
import { ProductArchivedEvent, ProductPublishedEvent, VariantCreatedEvent } from './events';
import { ProductStatusEnum } from './product-status.enum';
import { IProductVariantProps, ProductVariant } from './product-variant.model';
import { ProductVariantStatusEnum } from './product-variant-status.enum';

export interface IProductProps {
  id: number | null;
  name: string;
  slug: string;
  description?: string;
  status?: ProductStatusEnum;
  variants?: ProductVariant[];
  createdAt?: Date | null;
  updatedAt?: Date | null;
}

// `addVariant` takes the variant shape minus the fields the root owns — id and
// productId are assigned at persistence, status is always `ACTIVE` at creation,
// and timestamps are set by persistence.
export type AddVariantInput = Omit<
  IProductVariantProps,
  'id' | 'productId' | 'status' | 'createdAt' | 'updatedAt'
>;

// Product is the catalog aggregate root: it owns its ProductVariant children,
// the lifecycle state machine, and the cross-aggregate invariants. The
// `number | null` id mirrors the Order aggregate — null before persistence
// assigns one, concrete after `reconstitute`.
//
// No `version` column / optimistic lock: catalog is last-writer-wins, not in
// the no-oversell critical path (ADR-025).
export class Product extends AggregateRoot<number | null> {
  private readonly _name: string;
  private readonly _slug: string;
  private readonly _description: string;
  private _status: ProductStatusEnum;
  private readonly _variants: ProductVariant[];
  public readonly createdAt: Date | null;
  public readonly updatedAt: Date | null;

  private constructor(props: IProductProps) {
    if (typeof props.name !== 'string' || props.name.trim().length === 0) {
      throw new CatalogDomainException(
        CatalogErrorCodeEnum.PRODUCT_NAME_REQUIRED,
        'Product.name must be a non-empty string',
      );
    }
    if (typeof props.slug !== 'string' || props.slug.trim().length === 0) {
      throw new CatalogDomainException(
        CatalogErrorCodeEnum.PRODUCT_SLUG_REQUIRED,
        'Product.slug must be a non-empty string',
      );
    }

    super(props.id);
    this._name = props.name;
    this._slug = props.slug;
    this._description = props.description ?? '';
    this._status = props.status ?? ProductStatusEnum.DRAFT;
    this._variants = props.variants ?? [];
    this.createdAt = props.createdAt ?? null;
    this.updatedAt = props.updatedAt ?? null;
  }

  // Creates a DRAFT product with no variants and records NO event — there is no
  // ProductCreated event in the catalog model (the three events are
  // variant-created / published / archived). Variants are added through
  // `addVariant`, which records `VariantCreatedEvent` per variant.
  public static create(props: { name: string; slug: string; description?: string }): Product {
    return new Product({
      id: null,
      name: props.name,
      slug: props.slug,
      description: props.description,
      status: ProductStatusEnum.DRAFT,
      variants: [],
    });
  }

  // Rebuilds a persisted product from storage. Records no events.
  public static reconstitute(props: IProductProps): Product {
    return new Product(props);
  }

  public get name(): string {
    return this._name;
  }

  public get slug(): string {
    return this._slug;
  }

  public get description(): string {
    return this._description;
  }

  public get status(): ProductStatusEnum {
    return this._status;
  }

  public get variants(): readonly ProductVariant[] {
    return this._variants;
  }

  public isDraft(): boolean {
    return this._status === ProductStatusEnum.DRAFT;
  }

  public isActive(): boolean {
    return this._status === ProductStatusEnum.ACTIVE;
  }

  public isArchived(): boolean {
    return this._status === ProductStatusEnum.ARCHIVED;
  }

  // Adds a child variant through the root and records `VariantCreatedEvent`.
  // The variant id is null until persistence assigns it; the use case maps the
  // recorded event to the wire `catalog.variant.created` AFTER save, re-reading
  // the concrete id from the persisted aggregate (ADR-025).
  //
  // slug/sku global uniqueness is NOT checked here — the aggregate cannot see
  // other aggregates. That is a repository-level guarantee asserted in the
  // register/add-variant use-case spec (later work) via a repository double.
  public addVariant(input: AddVariantInput): ProductVariant {
    const variant = new ProductVariant({
      id: null,
      productId: this.id,
      sku: input.sku,
      gtin: input.gtin,
      optionValues: input.optionValues,
      weightG: input.weightG,
      dimensionsMm: input.dimensionsMm,
      status: ProductVariantStatusEnum.ACTIVE,
    });
    this._variants.push(variant);
    this.addDomainEvent(
      new VariantCreatedEvent({
        productId: this.id ?? 0,
        variantId: variant.id,
        sku: variant.sku,
      }),
    );
    return variant;
  }

  // draft → active. Precondition enforced here: at least one variant.
  //
  // A second precondition — "at least one ACTIVE Price" — belongs to a future
  // pricing capability and is deliberately NOT modelled in the domain. Until
  // pricing lands, the publish *use case* will warn (not block) on a price-less
  // product; the domain only guards the variant-count precondition. This is the
  // documented placeholder/seam for that future check (ADR-025).
  public publish(): void {
    if (!this.isDraft()) {
      throw new CatalogDomainException(
        CatalogErrorCodeEnum.PRODUCT_INVALID_STATE_TRANSITION,
        `Product.publish: only a draft product can be published (current status: ${this._status})`,
      );
    }
    if (this._variants.length < 1) {
      throw new CatalogDomainException(
        CatalogErrorCodeEnum.PRODUCT_PUBLISH_REQUIRES_VARIANT,
        'Product.publish: a product must have at least one variant to be published',
      );
    }

    this._status = ProductStatusEnum.ACTIVE;
    const variantIds = this._variants
      .map((variant) => variant.id)
      .filter((id): id is number => id !== null);
    this.addDomainEvent(
      new ProductPublishedEvent({ productId: this.id ?? 0, slug: this._slug, variantIds }),
    );
  }

  // active → archived. Archival is terminal — there is no archived → draft and
  // no archived → active path. Soft-delete via status; no `deletedAt`.
  public archive(): void {
    if (!this.isActive()) {
      throw new CatalogDomainException(
        CatalogErrorCodeEnum.PRODUCT_INVALID_STATE_TRANSITION,
        `Product.archive: only an active product can be archived (current status: ${this._status})`,
      );
    }

    this._status = ProductStatusEnum.ARCHIVED;
    this.addDomainEvent(new ProductArchivedEvent({ productId: this.id ?? 0 }));
  }
}
