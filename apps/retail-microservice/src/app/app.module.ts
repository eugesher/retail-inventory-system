import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { LoggerModule } from 'nestjs-pino';

import { configModuleConfig } from '@retail-inventory-system/config';
import { AppNameEnum } from '@retail-inventory-system/contracts';
import { DatabaseModule } from '@retail-inventory-system/database';
import { LoggerModuleConfig } from '@retail-inventory-system/observability';

// The retail microservice boots order-free: the legacy `orders` model has been
// torn down, and the rebuilt Cart/Order/Payment context lands in a later
// capability. `DatabaseModule.forRoot([])` keeps the (empty) connection wired so
// the cart entities slot in without re-establishing it; the service listens on
// `retail_queue` with no message handlers until then.
@Module({
  imports: [
    ConfigModule.forRoot(configModuleConfig),
    LoggerModule.forRoot(new LoggerModuleConfig(AppNameEnum.RETAIL_MICROSERVICE)),
    DatabaseModule.forRoot([]),
  ],
})
export class AppModule {}
