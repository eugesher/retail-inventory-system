import {
  ICatalogPriceChangedEvent,
  ICatalogPriceScheduledEvent,
} from '@retail-inventory-system/contracts';

import { Price, TaxCategory } from '../../../domain';
import { IPricingEventsPublisherPort, IPricingRepositoryPort } from '../../ports';

// Jest-free so the production build (which `tsconfig.app.json` excludes
// `*.spec.ts` but not `test-doubles.ts`) stays clean. Mirrors the catalog
// `test-doubles.ts`.

// In-memory pricing ledger. It is a *real* append-only store, not a stub: it
// keeps every appended row, closes a predecessor by replacing the stored row with
// its closed copy, and answers `findInEffect` with the coarse interval-containment
// filter — so a `SetPrice` followed by a `SelectApplicablePrice` against the same
// instance exercises the genuine end-to-end behavior (scheduling leaves the
// current answer unchanged until `validFrom`). `findInEffect` deliberately returns
// candidates in **insertion order, unsorted** so the use case's priority/recency
// resolution is what the select spec proves.
export class InMemoryPricingRepository implements IPricingRepositoryPort {
  public readonly appended: Price[] = [];

  private readonly prices = new Map<number, Price>();
  private nextPriceId = 7000;

  private readonly taxCategories = new Map<string, TaxCategory>();
  private nextTaxCategoryId = 300;

  // Seed a persisted row directly (id required) — used to set up an existing open
  // predecessor before the use case runs.
  public seed(price: Price): void {
    if (price.id === null) {
      throw new Error('InMemoryPricingRepository.seed: price must be persisted (id !== null)');
    }
    this.prices.set(price.id, price);
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
    // Close the predecessor first, in the same logical "transaction": overwrite
    // the stored open row with the already-closed copy the caller passed.
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
    // Intentionally unsorted (insertion order) — the resolution is the use case's.
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
