import { Module } from '@nestjs/common';

import { DatabaseModule } from '@retail-inventory-system/database';

import { PRICING_REPOSITORY } from './application/ports';
import {
  PriceEntity,
  PricingTypeormRepository,
  TaxCategoryEntity,
} from './infrastructure/persistence';

// The pricing bounded context colocates with the catalog microservice — it shares
// `catalog_queue` and keys on the same `variantId` backbone (ADR-025) rather than
// standing up a new deployable. It mirrors `catalog.module.ts`'s one divergence
// from the canonical template: the Nest module file sits at the module root.
//
// This stage wires the write/read STATE: the two TypeORM entities and the
// repository adapter bound to `PRICING_REPOSITORY`. `useExisting` shares the
// single adapter instance with code that injects the concrete class directly,
// while use cases depend on the port symbol. The `@MessagePattern` controller,
// the events-publisher adapter, and the `MicroserviceClientCatalogModule` import
// arrive with the pricing use cases and events.
@Module({
  imports: [DatabaseModule.forFeature([PriceEntity, TaxCategoryEntity])],
  providers: [
    PricingTypeormRepository,
    { provide: PRICING_REPOSITORY, useExisting: PricingTypeormRepository },
  ],
})
export class PricingModule {}
