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
import { toProductVariantView } from './catalog-view.factory';

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

    if (await this.repository.existsBySku(sku)) {
      throw new CatalogDomainException(
        CatalogErrorCodeEnum.VARIANT_SKU_TAKEN,
        `Variant sku "${sku}" is already taken`,
      );
    }

    product.addVariant({ sku, gtin, optionValues, weightG, dimensionsMm });

    const saved = await this.repository.save(product);

    const persistedVariant = saved.variants.find((variant) => variant.sku === sku);
    if (persistedVariant?.id == null) {
      throw new Error('AddVariantUseCase: persisted variant id missing after save');
    }

    this.logger.info(
      { correlationId, productId, variantId: persistedVariant.id, sku },
      'Variant created',
    );

    const events = product.pullDomainEvents();
    const createdEvent = events.find(
      (event): event is VariantCreatedEvent => event instanceof VariantCreatedEvent,
    );
    if (createdEvent === undefined) {
      throw new Error('AddVariantUseCase: VariantCreatedEvent missing after addVariant()');
    }

    try {
      await this.publisher.publishVariantCreated(
        {
          productId,
          variantId: persistedVariant.id,
          sku: persistedVariant.sku,
          eventVersion: 'v1',
          occurredAt: createdEvent.occurredAt.toISOString(),
          correlationId: correlationId ?? '',
        },
        correlationId,
      );
    } catch (err) {
      this.logger.warn(
        { err: err as Error, correlationId, productId, variantId: persistedVariant.id },
        'Failed to publish catalog.variant.created event',
      );
    }

    return toProductVariantView(persistedVariant);
  }
}
