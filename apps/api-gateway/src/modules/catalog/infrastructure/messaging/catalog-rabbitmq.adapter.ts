import { Inject, Injectable } from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import { firstValueFrom } from 'rxjs';

import {
  CategoryReparentView,
  CategoryTreeNodeView,
  CategoryView,
  IArchiveProductPayload,
  IAttachMediaPayload,
  IAttachVariantTaxCategoryPayload,
  ICategoryListQuery,
  ICategoryProductsQuery,
  ICategoryTreeQuery,
  ICorrelationPayload,
  ICreateCategoryPayload,
  ICreateTaxCategoryPayload,
  ICreateVariantPayload,
  IDetachMediaPayload,
  IGetProductBySlugQuery,
  IGetVariantQuery,
  IListProductsQuery,
  IMediaListQuery,
  IPage,
  IPriceQuery,
  IPriceSetPayload,
  IPublishProductPayload,
  IReclassifyProductPayload,
  IRegisterProductPayload,
  IReorderMediaPayload,
  IReparentCategoryPayload,
  MediaAssetView,
  PriceView,
  ProductCategoriesView,
  ProductVariantView,
  ProductView,
  ProductWithVariantsView,
  TaxCategoryView,
  VariantTaxHeaderView,
  VariantWithProductView,
} from '@retail-inventory-system/contracts';
import { MicroserviceClientTokenEnum, ROUTING_KEYS } from '@retail-inventory-system/messaging';

import {
  IAttachMediaCommand,
  IAttachVariantTaxCategoryCommand,
  ICatalogGatewayPort,
  ICategoryProductsCommand,
  ICreateCategoryCommand,
  ICreateTaxCategoryCommand,
  ICreateVariantCommand,
  IListCategoriesCommand,
  IListMediaCommand,
  IListProductsCommand,
  IPriceQueryCommand,
  IReclassifyProductCommand,
  IRegisterProductCommand,
  IReorderMediaCommand,
  IReparentCategoryCommand,
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

  public async createCategory(
    command: ICreateCategoryCommand,
    correlationId: string,
  ): Promise<CategoryView> {
    return firstValueFrom(
      this.client.send<CategoryView, ICreateCategoryPayload>(ROUTING_KEYS.CATALOG_CATEGORY_CREATE, {
        ...command,
        correlationId,
      }),
    );
  }

  public async reparentCategory(
    command: IReparentCategoryCommand,
    correlationId: string,
  ): Promise<CategoryReparentView> {
    return firstValueFrom(
      this.client.send<CategoryReparentView, IReparentCategoryPayload>(
        ROUTING_KEYS.CATALOG_CATEGORY_REPARENT,
        { ...command, correlationId },
      ),
    );
  }

  public async listCategories(
    query: IListCategoriesCommand,
    correlationId: string,
  ): Promise<CategoryView[]> {
    return firstValueFrom(
      this.client.send<CategoryView[], ICategoryListQuery>(ROUTING_KEYS.CATALOG_CATEGORY_LIST, {
        ...query,
        correlationId,
      }),
    );
  }

  public async getCategoryTree(slug: string, correlationId: string): Promise<CategoryTreeNodeView> {
    return firstValueFrom(
      this.client.send<CategoryTreeNodeView, ICategoryTreeQuery>(
        ROUTING_KEYS.CATALOG_CATEGORY_GET_TREE,
        { slug, correlationId },
      ),
    );
  }

  public async listCategoryProducts(
    query: ICategoryProductsCommand,
    correlationId: string,
  ): Promise<IPage<ProductWithVariantsView>> {
    return firstValueFrom(
      this.client.send<IPage<ProductWithVariantsView>, ICategoryProductsQuery>(
        ROUTING_KEYS.CATALOG_CATEGORY_LIST_PRODUCTS,
        { ...query, correlationId },
      ),
    );
  }

  public async reclassifyProduct(
    command: IReclassifyProductCommand,
    correlationId: string,
  ): Promise<ProductCategoriesView> {
    return firstValueFrom(
      this.client.send<ProductCategoriesView, IReclassifyProductPayload>(
        ROUTING_KEYS.CATALOG_PRODUCT_RECLASSIFY,
        { ...command, correlationId },
      ),
    );
  }

  public async attachMedia(
    command: IAttachMediaCommand,
    correlationId: string,
  ): Promise<MediaAssetView> {
    return firstValueFrom(
      this.client.send<MediaAssetView, IAttachMediaPayload>(ROUTING_KEYS.CATALOG_MEDIA_ATTACH, {
        ...command,
        correlationId,
      }),
    );
  }

  public async reorderMedia(
    command: IReorderMediaCommand,
    correlationId: string,
  ): Promise<MediaAssetView[]> {
    return firstValueFrom(
      this.client.send<MediaAssetView[], IReorderMediaPayload>(ROUTING_KEYS.CATALOG_MEDIA_REORDER, {
        ...command,
        correlationId,
      }),
    );
  }

  public async detachMedia(mediaId: number, correlationId: string): Promise<MediaAssetView> {
    return firstValueFrom(
      this.client.send<MediaAssetView, IDetachMediaPayload>(ROUTING_KEYS.CATALOG_MEDIA_DETACH, {
        mediaId,
        correlationId,
      }),
    );
  }

  public async listMedia(
    query: IListMediaCommand,
    correlationId: string,
  ): Promise<MediaAssetView[]> {
    return firstValueFrom(
      this.client.send<MediaAssetView[], IMediaListQuery>(ROUTING_KEYS.CATALOG_MEDIA_LIST, {
        ...query,
        correlationId,
      }),
    );
  }
}
