import { Inject, Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';

import { IPublishProductPayload, ProductView } from '@retail-inventory-system/contracts';

import { CatalogDomainException, CatalogErrorCodeEnum, ProductPublishedEvent } from '../../domain';
import {
  CATALOG_EVENTS_PUBLISHER,
  CATALOG_REPOSITORY,
  ICatalogEventsPublisherPort,
  ICatalogRepositoryPort,
} from '../ports';

// Publish Product flips a product `draft → active`. The domain (`Product.publish`)
// enforces the two write-side preconditions it can see: the product is in `draft`
// and has at least one variant; either violation raises a typed
// `CatalogDomainException`. After persistence the use case drains the recorded
// `ProductPublishedEvent` and emits `catalog.product.published`. The publish is
// best-effort post-commit — a broker failure is warn-logged and swallowed, the
// product stays active regardless (ADR-020 / ADR-025).
@Injectable()
export class PublishProductUseCase {
  constructor(
    @Inject(CATALOG_REPOSITORY)
    private readonly repository: ICatalogRepositoryPort,
    @Inject(CATALOG_EVENTS_PUBLISHER)
    private readonly publisher: ICatalogEventsPublisherPort,
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

    // Pricing precondition seam. A future pricing capability will assert the
    // product has at least one active Price before it can be published; Price is
    // owned by that capability and does not exist yet. Until it lands this warns
    // and proceeds rather than blocking, so the publish path keeps its shape and
    // the real check slots in here without reshaping the use case.
    this.logger.warn(
      { correlationId, productId },
      'active price precondition not yet enforced — pricing capability pending',
    );

    // Domain transition: rejects a non-draft product or a product with no
    // variants, and records a `ProductPublishedEvent` on success.
    product.publish();

    const saved = await this.repository.save(product);

    this.logger.info({ correlationId, productId }, 'Product published');

    // Drain the in-process events and map the publish to its versioned wire
    // event. `publish()` records exactly one `ProductPublishedEvent`.
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
      // Publish failures never raise — the product is already active.
      this.logger.warn(
        { err: err as Error, correlationId, productId },
        'Failed to publish catalog.product.published event',
      );
    }

    return {
      id: saved.id ?? productId,
      name: saved.name,
      slug: saved.slug,
      description: saved.description,
      status: saved.status,
      publishedAt,
    };
  }
}
