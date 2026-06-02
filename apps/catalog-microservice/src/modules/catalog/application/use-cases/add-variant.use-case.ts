import { Inject, Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';

import { ICreateVariantPayload, ProductVariantView } from '@retail-inventory-system/contracts';

import { CatalogDomainException, CatalogErrorCodeEnum, VariantCreatedEvent } from '../../domain';
import {
  CATALOG_EVENTS_PUBLISHER,
  CATALOG_REPOSITORY,
  ICatalogEventsPublisherPort,
  ICatalogRepositoryPort,
} from '../ports';

// Add Variant appends a variant to an existing product through the aggregate
// root (`Product.addVariant`), which records an in-process `VariantCreatedEvent`
// (its `variantId` is null until persistence assigns one). After save, the use
// case re-reads the concrete id from the persisted aggregate, maps the drained
// event to the versioned wire event, and emits `catalog.variant.created`. The
// publish is best-effort post-commit — a failure is warn-logged and swallowed,
// the variant is persisted regardless (ADR-020 / ADR-025).
@Injectable()
export class AddVariantUseCase {
  constructor(
    @Inject(CATALOG_REPOSITORY)
    private readonly repository: ICatalogRepositoryPort,
    @Inject(CATALOG_EVENTS_PUBLISHER)
    private readonly publisher: ICatalogEventsPublisherPort,
    @InjectPinoLogger(AddVariantUseCase.name)
    private readonly logger: PinoLogger,
  ) {}

  public async execute(payload: ICreateVariantPayload): Promise<ProductVariantView> {
    const { productId, sku, gtin, optionValues, weightG, dimensionsMm, correlationId } = payload;

    this.logger.info({ correlationId, productId, sku }, 'Received RPC: add variant');

    const product = await this.repository.findById(productId);
    if (product === null) {
      throw new CatalogDomainException(
        CatalogErrorCodeEnum.PRODUCT_NOT_FOUND,
        `Product #${productId} not found`,
      );
    }

    // Repository-level uniqueness pre-check (the hard guard is the UNIQUE
    // constraint on `product_variant.sku`); a duplicate raises a typed code.
    if (await this.repository.existsBySku(sku)) {
      throw new CatalogDomainException(
        CatalogErrorCodeEnum.VARIANT_SKU_TAKEN,
        `Variant sku "${sku}" is already taken`,
      );
    }

    // Records `VariantCreatedEvent` on the aggregate (variantId null pre-save).
    product.addVariant({ sku, gtin, optionValues, weightG, dimensionsMm });

    // `save` re-reads the persisted graph, so the returned variants carry
    // concrete ids (ADR-025; the repository's post-save findById).
    const saved = await this.repository.save(product);

    // `sku` is globally unique, so it identifies the just-added variant in the
    // persisted aggregate.
    const persistedVariant = saved.variants.find((variant) => variant.sku === sku);
    if (persistedVariant?.id == null) {
      throw new Error('AddVariantUseCase: persisted variant id missing after save');
    }

    this.logger.info(
      { correlationId, productId, variantId: persistedVariant.id, sku },
      'Variant created',
    );

    // Drain the in-process events and publish the matching wire event built with
    // the concrete id. addVariant records exactly one event here, but the loop
    // keeps the map-after-persistence shape honest if that ever changes.
    const events = product.pullDomainEvents();
    for (const event of events) {
      if (!(event instanceof VariantCreatedEvent)) continue;
      const variant = saved.variants.find((candidate) => candidate.sku === event.sku);
      if (variant?.id == null) continue;
      try {
        await this.publisher.publishVariantCreated(
          {
            productId,
            variantId: variant.id,
            sku: event.sku,
            eventVersion: 'v1',
            occurredAt: event.occurredAt.toISOString(),
            correlationId: correlationId ?? '',
          },
          correlationId,
        );
      } catch (err) {
        // Publish failures never raise — the variant is already persisted.
        this.logger.warn(
          { err: err as Error, correlationId, productId, variantId: variant.id },
          'Failed to publish catalog.variant.created event',
        );
      }
    }

    return {
      id: persistedVariant.id,
      productId: persistedVariant.productId ?? productId,
      sku: persistedVariant.sku,
      gtin: persistedVariant.gtin,
      optionValues: persistedVariant.optionValues,
      weightG: persistedVariant.weightG,
      dimensionsMm: persistedVariant.dimensionsMm,
      status: persistedVariant.status,
    };
  }
}
