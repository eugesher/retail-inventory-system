import { Inject, Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';

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

// Browse defaults — identical to `ListProductsUseCase` (the gateway normalizes
// page/size at the edge later; this guards the directly-reachable RMQ handler).
const DEFAULT_PAGE = 1;
const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;

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

    // Floor BEFORE the positivity guard (a fractional page in (0, 1) floors to 0,
    // which would become a negative OFFSET) — the `ListProductsUseCase` fallback.
    const flooredPage = Math.floor(query.page ?? 0);
    const page = flooredPage > 0 ? flooredPage : DEFAULT_PAGE;
    const flooredSize = Math.floor(query.pageSize ?? 0);
    const size = flooredSize > 0 ? Math.min(flooredSize, MAX_PAGE_SIZE) : DEFAULT_PAGE_SIZE;

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
