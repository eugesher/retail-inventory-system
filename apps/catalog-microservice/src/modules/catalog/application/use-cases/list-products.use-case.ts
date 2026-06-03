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
    // Floor BEFORE the positivity guard. A fractional page in (0, 1) passes a
    // `> 0` check but floors to 0, which the repository turns into a negative
    // OFFSET (`skip((page - 1) * size)`); flooring first collapses it to the
    // default. The gateway DTO already enforces an integer >= 1 over HTTP, so
    // this guards the directly-reachable RMQ handler (page is an unconstrained
    // number on the wire contract).
    const flooredPage = Math.floor(query.page ?? 0);
    const page = flooredPage > 0 ? flooredPage : DEFAULT_PAGE;
    const flooredSize = Math.floor(query.pageSize ?? 0);
    const size = flooredSize > 0 ? Math.min(flooredSize, MAX_PAGE_SIZE) : DEFAULT_PAGE_SIZE;

    this.logger.info({ correlationId, page, size, search }, 'Received RPC: list products');

    // Browse serves the published catalogue only: the repository filters on
    // `status = active` and excludes draft/archived products. The query's
    // `status` field defaults to `active` on the contract and is reserved for a
    // future non-active browse — it is not honoured by a separate path yet.
    const result = await this.repository.listActive({ page, size, search });

    // Carry total/page/size through unchanged; only `items` is re-projected onto
    // the wire view, so the page metadata cannot drift if the envelope grows a field.
    return {
      ...result,
      items: result.items.map((product) => toProductWithVariantsView(product)),
    };
  }
}
