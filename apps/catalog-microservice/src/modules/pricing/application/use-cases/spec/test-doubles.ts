import {
  ICatalogPriceChangedEvent,
  ICatalogPriceScheduledEvent,
} from '@retail-inventory-system/contracts';

import { Price, TaxCategory } from '../../../domain';
import { IPricingEventsPublisherPort, IPricingRepositoryPort } from '../../ports';

interface IFakeVariantRow {
  variantId: number;
  sku: string;
  taxCategoryId: number | null;
}

export class InMemoryPricingRepository implements IPricingRepositoryPort {
  public readonly appended: Price[] = [];

  private readonly prices = new Map<number, Price>();
  private nextPriceId = 7000;

  private readonly taxCategories = new Map<string, TaxCategory>();
  private nextTaxCategoryId = 300;

  private readonly variants = new Map<number, IFakeVariantRow>();

  public seed(price: Price): void {
    if (price.id === null) {
      throw new Error('InMemoryPricingRepository.seed: price must be persisted (id !== null)');
    }
    this.prices.set(price.id, price);
  }

  public seedVariant(input: {
    variantId: number;
    sku: string;
    taxCategoryId?: number | null;
  }): void {
    this.variants.set(input.variantId, {
      variantId: input.variantId,
      sku: input.sku,
      taxCategoryId: input.taxCategoryId ?? null,
    });
  }

  public findOpenPrice(variantId: number, currency: string): Promise<Price | null> {
    for (const price of this.prices.values()) {
      if (price.variantId === variantId && price.currency === currency && price.isOpen()) {
        return Promise.resolve(price);
      }
    }
    return Promise.resolve(null);
  }

  public appendPrice(newPrice: Price, predecessorToClose: Price | null): Promise<Price> {
    if (predecessorToClose !== null) {
      if (predecessorToClose.id === null) {
        throw new Error('InMemoryPricingRepository.appendPrice: predecessor must have an id');
      }
      this.prices.set(predecessorToClose.id, predecessorToClose);
    }

    const id = this.nextPriceId++;
    const persisted = Price.reconstitute({
      id,
      variantId: newPrice.variantId,
      currency: newPrice.currency,
      amountMinor: newPrice.amountMinor,
      validFrom: newPrice.validFrom,
      validTo: newPrice.validTo,
      priority: newPrice.priority,
    });
    this.prices.set(id, persisted);
    this.appended.push(persisted);
    return Promise.resolve(persisted);
  }

  public findInEffect(variantId: number, currency: string, asOf: Date): Promise<Price[]> {
    const at = asOf.getTime();
    const matched = [...this.prices.values()].filter(
      (price) =>
        price.variantId === variantId &&
        price.currency === currency &&
        price.validFrom.getTime() <= at &&
        (price.validTo === null || price.validTo.getTime() > at),
    );
    return Promise.resolve(matched);
  }

  public createTaxCategory(taxCategory: TaxCategory): Promise<TaxCategory> {
    const id = this.nextTaxCategoryId++;
    const persisted = TaxCategory.reconstitute({
      id,
      code: taxCategory.code,
      name: taxCategory.name,
      description: taxCategory.description,
    });
    this.taxCategories.set(persisted.code, persisted);
    return Promise.resolve(persisted);
  }

  public listTaxCategories(): Promise<TaxCategory[]> {
    return Promise.resolve([...this.taxCategories.values()]);
  }

  public findTaxCategoryByCode(code: string): Promise<TaxCategory | null> {
    return Promise.resolve(this.taxCategories.get(code) ?? null);
  }

  public attachTaxCategoryToVariant(variantId: number, taxCategoryId: number): Promise<void> {
    const variant = this.variants.get(variantId);
    if (variant !== undefined) {
      this.variants.set(variantId, { ...variant, taxCategoryId });
    }
    return Promise.resolve();
  }

  public findVariantTaxHeader(variantId: number): Promise<{
    variantId: number;
    sku: string;
    taxCategoryId: number | null;
    taxCategoryCode: string | null;
  } | null> {
    const variant = this.variants.get(variantId);
    if (variant === undefined) {
      return Promise.resolve(null);
    }

    let taxCategoryCode: string | null = null;
    if (variant.taxCategoryId !== null) {
      for (const category of this.taxCategories.values()) {
        if (category.id === variant.taxCategoryId) {
          taxCategoryCode = category.code;
          break;
        }
      }
    }

    return Promise.resolve({
      variantId: variant.variantId,
      sku: variant.sku,
      taxCategoryId: variant.taxCategoryId,
      taxCategoryCode,
    });
  }
}

export class InMemoryPricingEventsPublisher implements IPricingEventsPublisherPort {
  public readonly changed: { event: ICatalogPriceChangedEvent; correlationId?: string }[] = [];
  public readonly scheduled: { event: ICatalogPriceScheduledEvent; correlationId?: string }[] = [];

  public publishPriceChanged(
    event: ICatalogPriceChangedEvent,
    correlationId?: string,
  ): Promise<void> {
    this.changed.push({ event, correlationId });
    return Promise.resolve();
  }

  public publishPriceScheduled(
    event: ICatalogPriceScheduledEvent,
    correlationId?: string,
  ): Promise<void> {
    this.scheduled.push({ event, correlationId });
    return Promise.resolve();
  }
}
