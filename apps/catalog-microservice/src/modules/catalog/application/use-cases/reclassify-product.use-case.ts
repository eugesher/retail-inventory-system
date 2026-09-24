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

    const product = await this.catalogRepository.findById(productId);
    if (product === null) {
      throw new CatalogDomainException(
        CatalogErrorCodeEnum.PRODUCT_NOT_FOUND,
        `Product ${productId} not found`,
      );
    }

    const attachIds = await this.resolveCategoryIds(attachCategorySlugs, { rejectArchived: true });
    const detachIds = await this.resolveCategoryIds(detachCategorySlugs, { rejectArchived: false });

    await this.categoryRepository.attachProductCategories(productId, attachIds);
    await this.categoryRepository.detachProductCategories(productId, detachIds);

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
