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

// Publish Product flips a product `draft → active`. Preconditions guard the
// transition at two strengths.
//
// HARD gates (block the publish):
//   - The domain (`Product.publish`) enforces what the aggregate can see — the
//     product is in `draft` and has at least one variant.
//   - This use case adds the one cross-aggregate HARD precondition the domain
//     cannot see: every variant must have an in-effect Price in the default
//     currency, probed through `ACTIVE_PRICE_PROBE` (the catalog module cannot
//     import pricing state, so it asks the probe instead — ADR-017 / ADR-025 §6).
//     A missing active price raises `PRODUCT_PUBLISH_REQUIRES_PRICE` → 409, and a
//     price-less product genuinely breaks checkout, so blocking is correct.
//
// SOFT recommendation (informs, never blocks):
//   - A published product *should* carry ≥1 active media asset. A media-less
//     product is not broken — it only looks bare — so this is surfaced as a
//     `warnings[]` entry in the response, NOT a 409 (the deliberate contrast with
//     the price gate; ADR-029 §7). The check runs AFTER the save, by which point
//     the product is already active — so it is provably unable to influence the
//     outcome. The catalog domain cannot see media (a separate aggregate with no
//     FK back to `Product`), so — like the price gate — the recommendation lives
//     in the use case, not `Product.publish()` (ADR-025 §6). The probe is wrapped
//     in try/catch: a probe failure is warn-logged and swallowed, exactly as the
//     best-effort event emit is — a recommendation must never be able to fail a
//     publish.
//
// After persistence the use case drains the recorded `ProductPublishedEvent` and
// emits `catalog.product.published`; that publish is best-effort post-commit — a
// broker failure is warn-logged and swallowed, the product stays active
// regardless (ADR-020 / ADR-025).
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

    // Soft recommendation: warn (never block) when the now-active product carries
    // no media. Runs last, on the already-persisted aggregate — it cannot change
    // the publish outcome by construction.
    const warnings = await this.collectMediaWarnings(saved, productId, correlationId);

    const view: ProductView = { ...toProductView(saved), publishedAt };
    // Only attach `warnings` when there IS one — absent (`undefined`), never an
    // empty `[]`, on a clean publish (the `ProductView.warnings` contract).
    if (warnings.length > 0) {
      view.warnings = warnings;
    }
    return view;
  }

  // Probes for ≥1 active media asset across the product owner and every persisted
  // variant owner in ONE repository call, and returns the soft warnings to attach
  // to the publish response. A clean product (media present) returns `[]`. A probe
  // failure returns `[]` too — warn-logged and swallowed, so a recommendation can
  // never fail an already-committed publish (the best-effort event-emit stance).
  private async collectMediaWarnings(
    saved: Product,
    productId: number,
    correlationId?: string,
  ): Promise<PublishWarningView[]> {
    // The owner set = the product itself, plus one `product-variant` owner per
    // persisted variant. `saved` came back from the repository, so its variant ids
    // are concrete; the `!== null` filter is a type guard, not an expected branch.
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
