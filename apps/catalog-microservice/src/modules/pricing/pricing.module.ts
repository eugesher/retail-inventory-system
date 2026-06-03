import { Module } from '@nestjs/common';

// Empty-but-bootable pricing module. The pricing bounded context colocates with
// the catalog microservice — it shares `catalog_queue` and keys on the same
// `variantId` backbone (see ADR-025) rather than standing up a new deployable.
//
// Providers (repository + events-publisher adapters), the
// `DatabaseModule.forFeature([...])` entities, the `@MessagePattern` controller,
// and the `MicroserviceClientCatalogModule` import all arrive together with the
// pricing domain and its use cases. Until then this stays a valid, side-effect-free
// `@Module({})`. It mirrors `catalog.module.ts`'s one divergence from the
// canonical template: the Nest module file sits at the module root, not under
// `infrastructure/`.
@Module({})
export class PricingModule {}
