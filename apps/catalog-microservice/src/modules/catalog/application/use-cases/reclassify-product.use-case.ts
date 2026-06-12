import { Inject, Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';

import {
  IReclassifyProductPayload,
  ProductCategoriesView,
} from '@retail-inventory-system/contracts';

import { CatalogDomainException, CatalogErrorCodeEnum } from '../../domain';
import {
  CATALOG_REPOSITORY,
  CATEGORY_REPOSITORY,
  ICatalogRepositoryPort,
  ICategoryRepositoryPort,
} from '../ports';
import { toCategoryView } from './category-view.factory';
import { toProductView } from './catalog-view.factory';

// Reclassify Product changes a product's category memberships — a bulk attach +
// detach in one command (the gateway's attach route sends only the attach list,
// its detach route only the detach list; one RPC serves both). The membership is
// the bare `product_categories` join (ADR-029 §3): neither aggregate holds it in
// memory, so the use case orchestrates the product + category repositories and
// the join writes go straight to the category repository.
//
// It takes NO events-publisher port — the category capability emits nothing
// (ADR-029 §6), and the cleanest "emits nothing" guarantee is structural: there
// is no publisher to call.
@Injectable()
export class ReclassifyProductUseCase {
  constructor(
    @Inject(CATALOG_REPOSITORY)
    private readonly catalogRepository: ICatalogRepositoryPort,
    @Inject(CATEGORY_REPOSITORY)
    private readonly categoryRepository: ICategoryRepositoryPort,
    @InjectPinoLogger(ReclassifyProductUseCase.name)
    private readonly logger: PinoLogger,
  ) {}

  public async execute(payload: IReclassifyProductPayload): Promise<ProductCategoriesView> {
    const { productId, attachCategorySlugs, detachCategorySlugs, correlationId } = payload;

    this.logger.info(
      { correlationId, productId, attach: attachCategorySlugs, detach: detachCategorySlugs },
      'Received RPC: reclassify product',
    );

    // 1. The product must exist (404).
    const product = await this.catalogRepository.findById(productId);
    if (product === null) {
      throw new CatalogDomainException(
        CatalogErrorCodeEnum.PRODUCT_NOT_FOUND,
        `Product ${productId} not found`,
      );
    }

    // 2. Resolve every slug to a category id. An unknown slug in EITHER list is a
    //    404. An ARCHIVED category in the ATTACH list is a 409 (you cannot newly
    //    classify under a hidden category); archived in the DETACH list is fine —
    //    a historic membership must stay removable.
    const attachIds = await this.resolveCategoryIds(attachCategorySlugs, { rejectArchived: true });
    const detachIds = await this.resolveCategoryIds(detachCategorySlugs, { rejectArchived: false });

    // 3. Apply both — idempotent (`INSERT IGNORE` / `DELETE`): re-attaching an
    //    existing membership and detaching a non-membership are silent successes.
    //    The lists address distinct memberships in normal use; a slug present in
    //    both is a caller contradiction this use case does not police (attach then
    //    detach is the deterministic order, so it would net to detached).
    await this.categoryRepository.attachProductCategories(productId, attachIds);
    await this.categoryRepository.detachProductCategories(productId, detachIds);

    // 4. No event (ADR-029 §6) — see the class comment.

    // 5. Re-read the FULL current membership (the "updated product header"), so the
    //    caller sees exactly what the product now belongs to, not a diff.
    const categories = await this.categoryRepository.listCategoriesForProduct(productId);

    this.logger.info(
      { correlationId, productId, membershipCount: categories.length },
      'Product reclassified',
    );

    return {
      product: toProductView(product),
      categories: categories.map((category) => toCategoryView(category)),
    };
  }

  // Resolves a slug list to category ids, rejecting an unknown slug (404) and —
  // when `rejectArchived` — an archived category (409). The lookups run
  // concurrently; the validation pass that throws is a plain loop (no await), so
  // the rejection codes stay deterministic per the resolved order.
  private async resolveCategoryIds(
    slugs: string[],
    opts: { rejectArchived: boolean },
  ): Promise<number[]> {
    const resolved = await Promise.all(
      slugs.map(async (slug) => ({
        slug,
        category: await this.categoryRepository.findBySlug(slug),
      })),
    );

    const ids: number[] = [];
    for (const { slug, category } of resolved) {
      if (category === null) {
        throw new CatalogDomainException(
          CatalogErrorCodeEnum.CATEGORY_NOT_FOUND,
          `Category "${slug}" not found`,
        );
      }
      if (opts.rejectArchived && category.isArchived()) {
        throw new CatalogDomainException(
          CatalogErrorCodeEnum.CATEGORY_ARCHIVED,
          `Category "${slug}" is archived; cannot attach a product to an archived category`,
        );
      }
      if (category.id !== null) {
        ids.push(category.id);
      }
    }
    return ids;
  }
}
