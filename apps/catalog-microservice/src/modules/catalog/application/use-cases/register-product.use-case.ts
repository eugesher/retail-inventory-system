import { Inject, Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';

import { IRegisterProductPayload, ProductView } from '@retail-inventory-system/contracts';

import { CatalogDomainException, CatalogErrorCodeEnum, Product } from '../../domain';
import { CATALOG_REPOSITORY, ICatalogRepositoryPort } from '../ports';
import { toProductView } from './catalog-view.factory';

// Register Product is the first catalog write operation: it creates a `draft`
// product with no variants. Variants (and the eventual publish) are separate
// operations. There is no `ProductCreated` event — the catalog model emits
// events only for variant-created / published / archived (ADR-025).
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

    // Build first — the aggregate validates name/slug non-emptiness and throws
    // a typed `CatalogDomainException` on a violation.
    const product = Product.create({ name, slug, description });

    // Repository-level uniqueness pre-check: the domain cannot see other
    // aggregates, so a duplicate slug is rejected here with a typed code before
    // the INSERT would otherwise trip the UNIQUE constraint with a raw driver
    // error (ADR-025).
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
