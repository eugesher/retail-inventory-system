import { Inject, Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';

import { IPublishProductPayload, ProductView } from '@retail-inventory-system/contracts';

import { CatalogDomainException, CatalogErrorCodeEnum, ProductPublishedEvent } from '../../domain';
import {
  ACTIVE_PRICE_PROBE,
  CATALOG_DEFAULT_CURRENCY,
  CATALOG_EVENTS_PUBLISHER,
  CATALOG_REPOSITORY,
  IActivePriceProbePort,
  ICatalogEventsPublisherPort,
  ICatalogRepositoryPort,
} from '../ports';
import { toProductView } from './catalog-view.factory';

// Publish Product flips a product `draft → active`. Two layers of preconditions
// guard the transition. The domain (`Product.publish`) enforces what the
// aggregate can see — the product is in `draft` and has at least one variant.
// This use case adds the one cross-aggregate precondition the domain cannot see:
// every variant must have an in-effect Price in the default currency, probed
// through `ACTIVE_PRICE_PROBE` (the catalog module cannot import pricing state,
// so it asks the probe instead — ADR-017 / ADR-025 §6). A missing active price
// raises `PRODUCT_PUBLISH_REQUIRES_PRICE` → 409. After persistence the use case
// drains the recorded `ProductPublishedEvent` and emits `catalog.product.published`;
// that publish is best-effort post-commit — a broker failure is warn-logged and
// swallowed, the product stays active regardless (ADR-020 / ADR-025).
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

    // Cross-aggregate publish precondition: every variant must carry an in-effect
    // Price in the default currency. The catalog module cannot read pricing
    // state, so it asks the probe (a parameterized read of the `price` table —
    // ADR-017). An empty variant list makes the probe a no-op; the ≥1-variant
    // rule is the domain's, enforced by `product.publish()` just below, so a
    // variant-less product still fails on `PRODUCT_PUBLISH_REQUIRES_VARIANT`, not
    // here. A missing price is a conflict with the resource state, not malformed
    // input → 409 (`PRODUCT_PUBLISH_REQUIRES_PRICE`).
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

    return { ...toProductView(saved), publishedAt };
  }
}
