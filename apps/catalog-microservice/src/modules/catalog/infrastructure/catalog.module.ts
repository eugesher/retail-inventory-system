import { Module } from '@nestjs/common';

import { DatabaseModule } from '@retail-inventory-system/database';

// Empty placeholder for the catalog bounded context (entities/use-cases/handlers
// land in task-02). Its presence makes the per-module hexagonal tree exist so the
// eslint-plugin-boundaries globs already govern catalog before any domain code.
// `DatabaseModule.forFeature([])` is the ADR-019 (2026-05-27 amendment) preferred
// passthrough — the same shape `stock.module.ts` and `orders.module.ts` use.
@Module({
  imports: [DatabaseModule.forFeature([])],
})
export class CatalogModule {}
