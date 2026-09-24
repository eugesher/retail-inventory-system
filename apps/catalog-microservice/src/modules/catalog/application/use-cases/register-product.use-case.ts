import { Inject, Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';

import { IRegisterProductPayload, ProductView } from '@retail-inventory-system/contracts';

import { CatalogDomainException, CatalogErrorCodeEnum, Product } from '../../domain';
import { CATALOG_REPOSITORY, ICatalogRepositoryPort } from '../ports';
import { toProductView } from './catalog-view.factory';

@Injectable()
export class RegisterProductUseCase {
  constructor(
    @Inject(CATALOG_REPOSITORY)
    private readonly repository: ICatalogRepositoryPort,
    @InjectPinoLogger(RegisterProductUseCase.name)
    private readonly logger: PinoLogger,
  ) {}

  public async execute(payload: IRegisterProductPayload): Promise<ProductView> {
    const { name, slug, description, correlationId } = payload;

    this.logger.info({ correlationId, slug }, 'Received RPC: register product');

    const product = Product.create({ name, slug, description });

    if (await this.repository.existsBySlug(slug)) {
      throw new CatalogDomainException(
        CatalogErrorCodeEnum.PRODUCT_SLUG_TAKEN,
        `Product slug "${slug}" is already taken`,
      );
    }

    const saved = await this.repository.save(product);
    if (saved.id === null) {
      throw new Error('RegisterProductUseCase: repository returned an unsaved aggregate');
    }

    this.logger.info({ correlationId, productId: saved.id, slug }, 'Product registered');

    return toProductView(saved);
  }
}
