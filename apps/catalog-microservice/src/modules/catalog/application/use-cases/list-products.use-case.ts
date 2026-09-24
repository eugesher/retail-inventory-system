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
    const { page, size } = clampPageWindow(query.page, query.pageSize);

    this.logger.info({ correlationId, page, size, search }, 'Received RPC: list products');

    const result = await this.repository.listActive({ page, size, search });

    return {
      ...result,
      items: result.items.map((product) => toProductWithVariantsView(product)),
    };
  }
}
