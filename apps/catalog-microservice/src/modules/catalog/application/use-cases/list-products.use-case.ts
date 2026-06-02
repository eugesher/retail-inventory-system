import { Inject, Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';

import {
  IListProductsQuery,
  IPage,
  ProductWithVariantsView,
} from '@retail-inventory-system/contracts';

import { CATALOG_REPOSITORY, ICatalogRepositoryPort } from '../ports';
import { toProductWithVariantsView } from './catalog-view.factory';

// Browse defaults. `page` is 1-based; `size` is capped so an oversized
// `pageSize` cannot ask the DB for an unbounded result set.
const DEFAULT_PAGE = 1;
const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;

// List Products is the Customer-facing browse of the published catalogue: it
// returns a page of **active** products, each with its **active** variants
// (ADR-025). A `draft` product is invisible until published; an `archived`
// product drops out of browse but stays resolvable by id/slug through the
// by-slug / by-id read paths.
@Injectable()
export class ListProductsUseCase {
  constructor(
    @Inject(CATALOG_REPOSITORY)
    private readonly repository: ICatalogRepositoryPort,
    @InjectPinoLogger(ListProductsUseCase.name)
    private readonly logger: PinoLogger,
  ) {}

  public async execute(query: IListProductsQuery): Promise<IPage<ProductWithVariantsView>> {
    const { search, correlationId } = query;
    const page = query.page && query.page > 0 ? Math.floor(query.page) : DEFAULT_PAGE;
    const size =
      query.pageSize && query.pageSize > 0
        ? Math.min(Math.floor(query.pageSize), MAX_PAGE_SIZE)
        : DEFAULT_PAGE_SIZE;

    this.logger.info({ correlationId, page, size, search }, 'Received RPC: list products');

    // Browse serves the published catalogue only: the repository filters on
    // `status = active` and excludes draft/archived products. The query's
    // `status` field defaults to `active` on the contract and is reserved for a
    // future non-active browse — it is not honoured by a separate path yet.
    const result = await this.repository.listActive({ page, size, search });

    return {
      items: result.items.map((product) => toProductWithVariantsView(product)),
      total: result.total,
      page: result.page,
      size: result.size,
    };
  }
}
