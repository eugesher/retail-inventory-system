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

export type AddVariantInput = Omit<
  IProductVariantProps,
  'id' | 'productId' | 'status' | 'createdAt' | 'updatedAt'
>;

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
        sku: variant.sku,
      }),
    );
    return variant;
  }

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
