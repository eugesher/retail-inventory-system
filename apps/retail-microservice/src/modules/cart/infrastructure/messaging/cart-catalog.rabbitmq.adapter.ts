import { Inject, Injectable } from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import { firstValueFrom } from 'rxjs';

import { IPriceQuery, PriceView } from '@retail-inventory-system/contracts';
import { MicroserviceClientTokenEnum, ROUTING_KEYS } from '@retail-inventory-system/messaging';

import { ICartCatalogGatewayPort } from '../../application/ports';

@Injectable()
export class CartCatalogRabbitmqAdapter implements ICartCatalogGatewayPort {
  constructor(
    @Inject(MicroserviceClientTokenEnum.CATALOG_MICROSERVICE)
    private readonly catalogClient: ClientProxy,
  ) {}

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
