import { EntityClassOrSchema } from '@nestjs/typeorm/dist/interfaces/entity-class-or-schema.type';

import { PriceEntity, TaxCategoryEntity } from './infrastructure/persistence';

// The pricing module's public seam. `app/app.module.ts` consumes both exports:
// it imports `PricingModule` and spreads `pricingEntities` into the service's
// single `DatabaseModule.forRoot([...catalogEntities, ...pricingEntities])`, so
// both colocated modules share one MySQL connection. Adding the entities here is
// all `app.module.ts` needs — its spread is unchanged.
export const pricingEntities: EntityClassOrSchema[] = [PriceEntity, TaxCategoryEntity];

export * from './pricing.module';
