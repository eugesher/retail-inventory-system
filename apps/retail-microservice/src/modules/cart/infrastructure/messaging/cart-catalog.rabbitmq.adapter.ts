import { Inject, Injectable } from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import { firstValueFrom } from 'rxjs';

import { IPriceQuery, PriceView } from '@retail-inventory-system/contracts';
import { MicroserviceClientTokenEnum, ROUTING_KEYS } from '@retail-inventory-system/messaging';

import { ICartCatalogGatewayPort } from '../../application/ports';

// The cart context's outbound seam onto the catalog microservice's
// `catalog.price.select` RPC, and one of only two `ClientProxy` holders in the
// module (ADR-009 / ADR-020). The Add-to-Cart use case depends on
// `ICartCatalogGatewayPort`, never on `@nestjs/microservices`.
//
// `catalog.price.select` resolves the single applicable price for a
// `(variantId, currency)` scope at `asOf` (omitted → now), or `null` when none is
// in effect. The query is sent through the `CATALOG_MICROSERVICE` client so it
// lands on `catalog_queue`, where the pricing controller serves it.
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
    // `asOf` is left unset — the cart snapshots the price as of "now" — so the
    // catalog defaults it server-side. `firstValueFrom` materializes the cold
    // `send()` Observable and awaits the RPC reply.
    return firstValueFrom(
      this.catalogClient.send<PriceView | null, IPriceQuery>(ROUTING_KEYS.CATALOG_PRICE_SELECT, {
        variantId,
        currency,
        correlationId: correlationId ?? '',
      }),
    );
  }
}
