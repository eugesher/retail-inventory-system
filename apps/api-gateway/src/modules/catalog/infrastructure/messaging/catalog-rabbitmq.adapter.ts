import { Inject, Injectable } from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import { firstValueFrom } from 'rxjs';

import {
  IArchiveProductPayload,
  ICreateVariantPayload,
  IGetProductBySlugQuery,
  IGetVariantQuery,
  IListProductsQuery,
  IPage,
  IPublishProductPayload,
  IRegisterProductPayload,
  ProductVariantView,
  ProductView,
  ProductWithVariantsView,
  VariantWithProductView,
} from '@retail-inventory-system/contracts';
import { MicroserviceClientTokenEnum, ROUTING_KEYS } from '@retail-inventory-system/messaging';

import {
  ICatalogGatewayPort,
  ICreateVariantCommand,
  IListProductsCommand,
  IRegisterProductCommand,
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
}
