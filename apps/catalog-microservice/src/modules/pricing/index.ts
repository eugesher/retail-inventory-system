import { EntityClassOrSchema } from '@nestjs/typeorm/dist/interfaces/entity-class-or-schema.type';

// The pricing module's public seam. `app/app.module.ts` consumes both exports:
// it imports `PricingModule` and spreads `pricingEntities` into the service's
// single `DatabaseModule.forRoot([...catalogEntities, ...pricingEntities])`.
//
// `pricingEntities` is empty today — pricing owns no persistence yet. The
// `Price` / `TaxCategory` TypeORM entities land with the pricing domain and are
// appended to this array then. Establishing the seam now (typed as a concrete
// entity array, never `undefined`, so the composition-root spread type-checks)
// lets the entities arrive without touching `app.module.ts` again.
export const pricingEntities: EntityClassOrSchema[] = [];

export * from './pricing.module';
