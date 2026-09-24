import { Inject, Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';

import {
  IGetProductBySlugQuery,
  ProductWithVariantsView,
} from '@retail-inventory-system/contracts';

import { CatalogDomainException, CatalogErrorCodeEnum } from '../../domain';
import { CATALOG_REPOSITORY, ICatalogRepositoryPort } from '../ports';
import { toProductWithVariantsView } from './catalog-view.factory';

@Injectable()
export class GetProductBySlugUseCase {
  constructor(
    @Inject(CATALOG_REPOSITORY)
    private readonly repository: ICatalogRepositoryPort,
    @InjectPinoLogger(GetProductBySlugUseCase.name)
    private readonly logger: PinoLogger,
  ) {}

  public async execute(query: IGetProductBySlugQuery): Promise<ProductWithVariantsView> {
    const { slug, correlationId } = query;

    this.logger.info({ correlationId, slug }, 'Received RPC: get product by slug');

    const product = await this.repository.findBySlug(slug);
    if (product === null) {
      throw new CatalogDomainException(
        CatalogErrorCodeEnum.PRODUCT_NOT_FOUND,
        `Product with slug "${slug}" not found`,
      );
    }

    return toProductWithVariantsView(product);
  }
}
