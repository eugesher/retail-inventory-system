import { Inject, Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';

import { clampPageWindow } from '@retail-inventory-system/common';
import {
  ICategoryProductsQuery,
  IPage,
  ProductWithVariantsView,
} from '@retail-inventory-system/contracts';

import { CatalogDomainException, CatalogErrorCodeEnum } from '../../domain';
import {
  CATALOG_REPOSITORY,
  CATEGORY_REPOSITORY,
  ICatalogRepositoryPort,
  ICategoryRepositoryPort,
} from '../ports';
import { toProductWithVariantsView } from './catalog-view.factory';

// List Category Products is the category-scoped browse: a page of ACTIVE products
// (each with its active variants — identical semantics to the plain browse,
// ADR-025) attached to a category, optionally widened to its whole active
// subtree. It spans two ports — the category repository resolves the slug and the
// descendant scope, the catalog repository runs the membership-filtered product
// read (products belong with the product repository, ADR-029 §8). Records no
// event (ADR-029 §6).
@Injectable()
export class ListCategoryProductsUseCase {
  constructor(
    @Inject(CATALOG_REPOSITORY)
    private readonly catalogRepository: ICatalogRepositoryPort,
    @Inject(CATEGORY_REPOSITORY)
    private readonly categoryRepository: ICategoryRepositoryPort,
    @InjectPinoLogger(ListCategoryProductsUseCase.name)
    private readonly logger: PinoLogger,
  ) {}

  public async execute(query: ICategoryProductsQuery): Promise<IPage<ProductWithVariantsView>> {
    const { slug, includeDescendants, correlationId } = query;

    // Normalize the untrusted page/size from the wire contract — the same window
    // as the plain browse (`ListProductsUseCase`), now via the shared helper.
    const { page, size } = clampPageWindow(query.page, query.pageSize);

    this.logger.info(
      { correlationId, slug, includeDescendants: includeDescendants ?? false, page, size },
      'Received RPC: list category products',
    );

    // Resolve the category exactly as the tree read does: a missing OR archived
    // category is a 404 (an archived category is hidden from browse).
    const category = await this.categoryRepository.findBySlug(slug);
    if (category === null || category.isArchived()) {
      throw new CatalogDomainException(
        CatalogErrorCodeEnum.CATEGORY_NOT_FOUND,
        `Category "${slug}" not found`,
      );
    }

    // Scope = the named category, plus the active subtree's ids when
    // `includeDescendants`. A Set dedupes self (`listSubtree` includes the root)
    // and any node reachable twice.
    const categoryIds = new Set<number>();
    if (category.id !== null) {
      categoryIds.add(category.id);
    }
    if (includeDescendants) {
      const subtree = await this.categoryRepository.listSubtree(category.path, {
        activeOnly: true,
      });
      for (const node of subtree) {
        if (node.id !== null) {
          categoryIds.add(node.id);
        }
      }
    }

    const result = await this.catalogRepository.listActiveByCategoryIds({
      categoryIds: [...categoryIds],
      page,
      size,
    });

    // Carry total/page/size through unchanged; only `items` is re-projected onto
    // the wire view (active variants only — the shared catalog view factory).
    return {
      ...result,
      items: result.items.map((product) => toProductWithVariantsView(product)),
    };
  }
}
