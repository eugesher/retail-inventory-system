// The pricing module's public seam. `app/app.module.ts` consumes both exports: it imports
// `PricingModule` and spreads `pricingEntities` into the service's single
// `DatabaseModule.forRoot([...catalogEntities, ...pricingEntities])`, so both colocated
// modules share one MySQL connection. Adding an entity to the list in
// `infrastructure/persistence/` is all `app.module.ts` needs — its spread is unchanged.
export { pricingEntities } from './infrastructure/persistence';
export * from './pricing.module';
