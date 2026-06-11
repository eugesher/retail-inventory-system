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

// The orders context's outbound seam onto the catalog microservice, and one of the
// module's `ClientProxy` holders (ADR-009 / ADR-020). Place Order depends on
// `IOrderCatalogGatewayPort`, never on `@nestjs/microservices`. Both RPCs are sent
// through the `CATALOG_MICROSERVICE` client so they land on `catalog_queue`, where
// the catalog + pricing controllers serve them.
//
// `catalog.variant.get` returns the variant + its parent product header (`sku`,
// `product.name`, `optionValues`) — the source of the `OrderLine` identity snapshot;
// the catalog rejects an unknown id, so the place use case never has to null-check
// here. `catalog.price.select` resolves the single applicable price as of now
// (`asOf` unset), or `null` when none is in effect.
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
    // `asOf` is left unset — the order snapshots the price as of "now" — so the
    // catalog defaults it server-side.
    return firstValueFrom(
      this.catalogClient.send<PriceView | null, IPriceQuery>(ROUTING_KEYS.CATALOG_PRICE_SELECT, {
        variantId,
        currency,
        correlationId: correlationId ?? '',
      }),
    );
  }
}
