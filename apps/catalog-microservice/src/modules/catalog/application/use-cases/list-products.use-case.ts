import { Inject, Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';

import { clampPageWindow } from '@retail-inventory-system/common';
import {
  IListProductsQuery,
  IPage,
  ProductWithVariantsView,
} from '@retail-inventory-system/contracts';

import { CATALOG_REPOSITORY, ICatalogRepositoryPort } from '../ports';
import { toProductWithVariantsView } from './catalog-view.factory';

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
    // Normalize the untrusted page/size from the wire contract (the gateway DTO
    // enforces an integer >= 1 over HTTP, but this RMQ handler is directly reachable).
    const { page, size } = clampPageWindow(query.page, query.pageSize);

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
