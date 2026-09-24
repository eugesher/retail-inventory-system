import { Inject, Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';

import {
  CATALOG_PRODUCT_PUBLISH_NO_ACTIVE_MEDIA,
  IPublishProductPayload,
  MediaOwnerTypeEnum,
  ProductView,
  PublishWarningView,
} from '@retail-inventory-system/contracts';

import {
  CatalogDomainException,
  CatalogErrorCodeEnum,
  Product,
  ProductPublishedEvent,
} from '../../domain';
import {
  ACTIVE_PRICE_PROBE,
  CATALOG_DEFAULT_CURRENCY,
  CATALOG_EVENTS_PUBLISHER,
  CATALOG_REPOSITORY,
  IActivePriceProbePort,
  ICatalogEventsPublisherPort,
  ICatalogRepositoryPort,
  IMediaAssetRepositoryPort,
  MEDIA_ASSET_REPOSITORY,
} from '../ports';
import { toProductView } from './catalog-view.factory';

@Injectable()
export class PublishProductUseCase {
  constructor(
    @Inject(CATALOG_REPOSITORY)
    private readonly repository: ICatalogRepositoryPort,
    @Inject(CATALOG_EVENTS_PUBLISHER)
    private readonly publisher: ICatalogEventsPublisherPort,
    @Inject(ACTIVE_PRICE_PROBE)
    private readonly priceProbe: IActivePriceProbePort,
    @Inject(CATALOG_DEFAULT_CURRENCY)
    private readonly defaultCurrency: string,
    @Inject(MEDIA_ASSET_REPOSITORY)
    private readonly mediaRepository: IMediaAssetRepositoryPort,
    @InjectPinoLogger(PublishProductUseCase.name)
    private readonly logger: PinoLogger,
  ) {}

  public async execute(payload: IPublishProductPayload): Promise<ProductView> {
    const { productId, correlationId } = payload;

    this.logger.info({ correlationId, productId }, 'Received RPC: publish product');

    const product = await this.repository.findById(productId);
    if (product === null) {
      throw new CatalogDomainException(
        CatalogErrorCodeEnum.PRODUCT_NOT_FOUND,
        `Product #${productId} not found`,
      );
    }

    const variantIds = product.variants
      .map((variant) => variant.id)
      .filter((id): id is number => id !== null);
    const missing = await this.priceProbe.findVariantsMissingActivePrice(
      variantIds,
      this.defaultCurrency,
    );
    if (missing.length > 0) {
      throw new CatalogDomainException(
        CatalogErrorCodeEnum.PRODUCT_PUBLISH_REQUIRES_PRICE,
        `Cannot publish #${productId}: variant(s) ${missing.join(', ')} have no active ${this.defaultCurrency} price`,
      );
    }

    product.publish();

    const saved = await this.repository.save(product);

    this.logger.info({ correlationId, productId }, 'Product published');

    const events = product.pullDomainEvents();
    const publishedEvent = events.find(
      (event): event is ProductPublishedEvent => event instanceof ProductPublishedEvent,
    );
    if (publishedEvent === undefined) {
      throw new Error('PublishProductUseCase: ProductPublishedEvent missing after publish()');
    }

    const publishedAt = publishedEvent.occurredAt.toISOString();

    try {
      await this.publisher.publishProductPublished(
        {
          productId,
          slug: publishedEvent.slug,
          variantIds: publishedEvent.variantIds,
          publishedAt,
          eventVersion: 'v1',
          occurredAt: publishedAt,
          correlationId: correlationId ?? '',
        },
        correlationId,
      );
    } catch (err) {
      this.logger.warn(
        { err: err as Error, correlationId, productId },
        'Failed to publish catalog.product.published event',
      );
    }

    const warnings = await this.collectMediaWarnings(saved, productId, correlationId);

    const view: ProductView = { ...toProductView(saved), publishedAt };
    if (warnings.length > 0) {
      view.warnings = warnings;
    }
    return view;
  }

  private async collectMediaWarnings(
    saved: Product,
    productId: number,
    correlationId?: string,
  ): Promise<PublishWarningView[]> {
    const owners = [
      { ownerType: MediaOwnerTypeEnum.PRODUCT, ownerId: productId },
      ...saved.variants
        .map((variant) => variant.id)
        .filter((id): id is number => id !== null)
        .map((id) => ({ ownerType: MediaOwnerTypeEnum.PRODUCT_VARIANT, ownerId: id })),
    ];

    try {
      const hasActiveMedia = await this.mediaRepository.hasActiveForOwners(owners);
      if (hasActiveMedia) {
        return [];
      }

      this.logger.warn(
        { correlationId, productId },
        'Published product has no active media asset (≥1 recommended)',
      );
      return [
        {
          code: CATALOG_PRODUCT_PUBLISH_NO_ACTIVE_MEDIA,
          message: `Product #${productId} has no active media asset; publishing proceeded — attaching at least one image is recommended.`,
        },
      ];
    } catch (err) {
      this.logger.warn(
        { err: err as Error, correlationId, productId },
        'Media soft-warning probe failed; publish unaffected, no warning emitted',
      );
      return [];
    }
  }
}
