import { Inject, Injectable } from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import { firstValueFrom } from 'rxjs';

import {
  IArchiveProductPayload,
  IAttachVariantTaxCategoryPayload,
  ICorrelationPayload,
  ICreateTaxCategoryPayload,
  ICreateVariantPayload,
  IGetProductBySlugQuery,
  IGetVariantQuery,
  IListProductsQuery,
  IPage,
  IPriceQuery,
  IPriceSetPayload,
  IPublishProductPayload,
  IRegisterProductPayload,
  PriceView,
  ProductVariantView,
  ProductView,
  ProductWithVariantsView,
  TaxCategoryView,
  VariantTaxHeaderView,
  VariantWithProductView,
} from '@retail-inventory-system/contracts';
import { MicroserviceClientTokenEnum, ROUTING_KEYS } from '@retail-inventory-system/messaging';

import {
  IAttachVariantTaxCategoryCommand,
  ICatalogGatewayPort,
  ICreateTaxCategoryCommand,
  ICreateVariantCommand,
  IListProductsCommand,
  IPriceQueryCommand,
  IRegisterProductCommand,
  ISetPriceCommand,
} from '../../application/ports';

// The single `ClientProxy` holder for the catalog gateway module (ADR-009 /
// ADR-020). Each method materializes the RPC with `firstValueFrom` and stitches
// the transport-level `correlationId` onto the wire payload; everything else in
// the module depends on `ICatalogGatewayPort`, never on `@nestjs/microservices`.
@Injectable()
export class CatalogRabbitmqAdapter implements ICatalogGatewayPort {
  constructor(
    @Inject(MicroserviceClientTokenEnum.CATALOG_MICROSERVICE)
    private readonly client: ClientProxy,
  ) {}

  public async registerProduct(
    command: IRegisterProductCommand,
    correlationId: string,
  ): Promise<ProductView> {
    return firstValueFrom(
      this.client.send<ProductView, IRegisterProductPayload>(
        ROUTING_KEYS.CATALOG_PRODUCT_REGISTER,
        {
          ...command,
          correlationId,
        },
      ),
    );
  }

  public async createVariant(
    command: ICreateVariantCommand,
    correlationId: string,
  ): Promise<ProductVariantView> {
    return firstValueFrom(
      this.client.send<ProductVariantView, ICreateVariantPayload>(
        ROUTING_KEYS.CATALOG_VARIANT_CREATE,
        { ...command, correlationId },
      ),
    );
  }

  public async publishProduct(productId: number, correlationId: string): Promise<ProductView> {
    return firstValueFrom(
      this.client.send<ProductView, IPublishProductPayload>(ROUTING_KEYS.CATALOG_PRODUCT_PUBLISH, {
        productId,
        correlationId,
      }),
    );
  }

  public async archiveProduct(productId: number, correlationId: string): Promise<ProductView> {
    return firstValueFrom(
      this.client.send<ProductView, IArchiveProductPayload>(ROUTING_KEYS.CATALOG_PRODUCT_ARCHIVE, {
        productId,
        correlationId,
      }),
    );
  }

  public async listProducts(
    query: IListProductsCommand,
    correlationId: string,
  ): Promise<IPage<ProductWithVariantsView>> {
    return firstValueFrom(
      this.client.send<IPage<ProductWithVariantsView>, IListProductsQuery>(
        ROUTING_KEYS.CATALOG_PRODUCT_LIST,
        { ...query, correlationId },
      ),
    );
  }

  public async getProductBySlug(
    slug: string,
    correlationId: string,
  ): Promise<ProductWithVariantsView> {
    return firstValueFrom(
      this.client.send<ProductWithVariantsView, IGetProductBySlugQuery>(
        ROUTING_KEYS.CATALOG_PRODUCT_GET,
        { slug, correlationId },
      ),
    );
  }

  public async getVariant(
    variantId: number,
    correlationId: string,
  ): Promise<VariantWithProductView> {
    return firstValueFrom(
      this.client.send<VariantWithProductView, IGetVariantQuery>(ROUTING_KEYS.CATALOG_VARIANT_GET, {
        variantId,
        correlationId,
      }),
    );
  }

  public async setPrice(command: ISetPriceCommand, correlationId: string): Promise<PriceView> {
    return firstValueFrom(
      this.client.send<PriceView, IPriceSetPayload>(ROUTING_KEYS.CATALOG_PRICE_SET, {
        ...command,
        correlationId,
      }),
    );
  }

  public async listPrices(query: IPriceQueryCommand, correlationId: string): Promise<PriceView[]> {
    return firstValueFrom(
      this.client.send<PriceView[], IPriceQuery>(ROUTING_KEYS.CATALOG_PRICE_LIST, {
        ...query,
        correlationId,
      }),
    );
  }

  public async getApplicablePrice(
    query: IPriceQueryCommand,
    correlationId: string,
  ): Promise<PriceView | null> {
    return firstValueFrom(
      this.client.send<PriceView | null, IPriceQuery>(ROUTING_KEYS.CATALOG_PRICE_SELECT, {
        ...query,
        correlationId,
      }),
    );
  }

  public async createTaxCategory(
    command: ICreateTaxCategoryCommand,
    correlationId: string,
  ): Promise<TaxCategoryView> {
    return firstValueFrom(
      this.client.send<TaxCategoryView, ICreateTaxCategoryPayload>(
        ROUTING_KEYS.CATALOG_TAX_CATEGORY_CREATE,
        { ...command, correlationId },
      ),
    );
  }

  public async listTaxCategories(correlationId: string): Promise<TaxCategoryView[]> {
    return firstValueFrom(
      this.client.send<TaxCategoryView[], ICorrelationPayload>(
        ROUTING_KEYS.CATALOG_TAX_CATEGORY_LIST,
        { correlationId },
      ),
    );
  }

  public async attachVariantTaxCategory(
    command: IAttachVariantTaxCategoryCommand,
    correlationId: string,
  ): Promise<VariantTaxHeaderView> {
    return firstValueFrom(
      this.client.send<VariantTaxHeaderView, IAttachVariantTaxCategoryPayload>(
        ROUTING_KEYS.CATALOG_VARIANT_SET_TAX_CATEGORY,
        { ...command, correlationId },
      ),
    );
  }
}
