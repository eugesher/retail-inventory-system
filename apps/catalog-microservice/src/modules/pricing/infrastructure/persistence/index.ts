import { PriceEntity } from './price.entity';
import { TaxCategoryEntity } from './tax-category.entity';

// The module's entity list: `DatabaseModule.forRoot(...)` in `app.module.ts`, and
// `forFeature(...)` in the module file. UNANNOTATED on purpose — see the note on
// `DatabaseModule.forRoot` for why the parameter type must not be used here.
export const pricingEntities = [PriceEntity, TaxCategoryEntity];

export { PriceEntity } from './price.entity';
export { TaxCategoryEntity } from './tax-category.entity';
export * from './price.mapper';
export * from './tax-category.mapper';
export * from './pricing-typeorm.repository';
