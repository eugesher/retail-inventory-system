import { Inject, Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';

import { IGetVariantQuery, VariantWithProductView } from '@retail-inventory-system/contracts';

import { CatalogDomainException, CatalogErrorCodeEnum } from '../../domain';
import { CATALOG_REPOSITORY, ICatalogRepositoryPort } from '../ports';
import { toProductVariantView, toProductView } from './catalog-view.factory';

// Get Variant resolves a single variant by id, together with its parent product
// header. The variant is the downstream backbone key (inventory stock, pricing,
// order lines key on `variantId` — ADR-025), so it is addressable on its own on
// the read path even though it is only mutated through the `Product` root on the
// write path. The fetch is **status-agnostic**: an archived variant (and an
// archived parent product) stays resolvable so historical order/stock references
// that key on `variantId` never dangle.
@Injectable()
export class GetVariantUseCase {
  constructor(
    @Inject(CATALOG_REPOSITORY)
    private readonly repository: ICatalogRepositoryPort,
    @InjectPinoLogger(GetVariantUseCase.name)
    private readonly logger: PinoLogger,
  ) {}

  public async execute(query: IGetVariantQuery): Promise<VariantWithProductView> {
    const { variantId, correlationId } = query;

    this.logger.info({ correlationId, variantId }, 'Received RPC: get variant');

    const variant = await this.repository.findVariantById(variantId);
    if (variant === null) {
      throw new CatalogDomainException(
        CatalogErrorCodeEnum.VARIANT_NOT_FOUND,
        `Variant #${variantId} not found`,
      );
    }

    const productId = variant.productId;
    if (productId === null) {
      throw new Error('GetVariantUseCase: persisted variant is missing its productId');
    }

    // The variant carries a non-null FK to its product (ON DELETE RESTRICT), so
    // a missing parent here is a data-integrity breach rather than a not-found.
    const product = await this.repository.findById(productId);
    if (product === null) {
      throw new CatalogDomainException(
        CatalogErrorCodeEnum.PRODUCT_NOT_FOUND,
        `Parent product #${productId} for variant #${variantId} not found`,
      );
    }

    return {
      ...toProductVariantView(variant),
      product: toProductView(product),
    };
  }
}
