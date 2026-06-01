import { Module } from '@nestjs/common';

import { DatabaseModule } from '@retail-inventory-system/database';

// Empty placeholder for the catalog bounded context. Task-02 registers the
// `ProductEntity` / `ProductVariantEntity` in the `DatabaseModule.forFeature`
// call below, adds the repository adapters under `infrastructure/persistence/`,
// the use cases under `application/`, and the `@MessagePattern` handlers under
// `presentation/`. Its presence here asserts the per-module hexagonal tree
// exists so the eslint-plugin-boundaries config (apps/*/src/modules/*/... globs)
// already governs the catalog module before any domain code lands.
//
// `DatabaseModule.forFeature([])` is the ADR-019 (2026-05-27 amendment) preferred
// passthrough for microservice modules without an inline-imports requirement —
// the same shape `stock.module.ts` and `orders.module.ts` use.
@Module({
  imports: [DatabaseModule.forFeature([])],
})
export class CatalogModule {}
