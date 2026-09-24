import { Inject, Injectable } from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import { firstValueFrom } from 'rxjs';

import {
  IGetVariantQuery,
  IPriceQuery,
  PriceView,
  VariantWithProductView,
} from '@retail-inventory-system/contracts';
import { MicroserviceClientTokenEnum, ROUTING_KEYS } from '@retail-inventory-system/messaging';

import { IOrderCatalogGatewayPort } from '../../application/ports';

@Injectable()
export class OrderCatalogRabbitmqAdapter implements IOrderCatalogGatewayPort {
  constructor(
    @Inject(MicroserviceClientTokenEnum.CATALOG_MICROSERVICE)
    private readonly catalogClient: ClientProxy,
  ) {}

  public async getVariant(
    variantId: number,
    correlationId?: string,
  ): Promise<VariantWithProductView> {
    return firstValueFrom(
      this.catalogClient.send<VariantWithProductView, IGetVariantQuery>(
        ROUTING_KEYS.CATALOG_VARIANT_GET,
        { variantId, correlationId: correlationId ?? '' },
      ),
    );
  }

  public async selectApplicablePrice(
    variantId: number,
    currency: string,
    correlationId?: string,
  ): Promise<PriceView | null> {
    return firstValueFrom(
      this.catalogClient.send<PriceView | null, IPriceQuery>(ROUTING_KEYS.CATALOG_PRICE_SELECT, {
        variantId,
        currency,
        correlationId: correlationId ?? '',
      }),
    );
  }
}
