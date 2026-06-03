import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { LoggerModule } from 'nestjs-pino';

import { configModuleConfig } from '@retail-inventory-system/config';
import { AppNameEnum } from '@retail-inventory-system/contracts';
import { DatabaseModule } from '@retail-inventory-system/database';
import { LoggerModuleConfig } from '@retail-inventory-system/observability';

import { catalogEntities, CatalogModule } from '../modules/catalog';
import { PricingModule, pricingEntities } from '../modules/pricing';

@Module({
  imports: [
    ConfigModule.forRoot(configModuleConfig),
    LoggerModule.forRoot(new LoggerModuleConfig(AppNameEnum.CATALOG_MICROSERVICE)),
    // The service owns one MySQL connection shared by both colocated modules.
    // `catalogEntities` is typed `TypeOrmModuleOptions['entities']` — a `MixedList`
    // the type system also allows to be an object map or `undefined`, neither of
    // which can be spread; at runtime it is always the catalog entity-class array,
    // so we treat it as the same concrete entity-array shape as `pricingEntities`
    // and merge both halves into the single `forRoot`. `pricingEntities` is empty
    // today and gains the pricing entities later — no further change here.
    DatabaseModule.forRoot([...(catalogEntities as typeof pricingEntities), ...pricingEntities]),
    CatalogModule,
    PricingModule,
  ],
})
export class AppModule {}
