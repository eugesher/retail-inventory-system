import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { LoggerModule } from 'nestjs-pino';

import { configModuleConfig } from '@retail-inventory-system/config';
import { AppNameEnum } from '@retail-inventory-system/contracts';
import { DatabaseModule } from '@retail-inventory-system/database';
import { LoggerModuleConfig } from '@retail-inventory-system/observability';

import { CartModule, cartEntities } from '../modules/cart';
import { OrdersModule, orderEntities } from '../modules/orders';

// The retail microservice owns the rebuilt checkout context. The `cart` module's
// mutable `Cart`/`CartLine` aggregate and the `orders` module's immutable `Order`/
// `OrderLine` + polymorphic `Address` aggregates are both registered as foundation;
// the `Payment` aggregate and every cart/order operation land in later capabilities.
// `DatabaseModule.forRoot` opens the one MySQL connection the context's modules
// share — `cartEntities` + `orderEntities` are concrete entity arrays, merged into
// one list. No `@MessagePattern` / `@EventPattern` handlers exist yet — the
// operations + their gateway arrive with a later capability, so the service still
// listens on `retail_queue` with no handlers.
@Module({
  imports: [
    ConfigModule.forRoot(configModuleConfig),
    LoggerModule.forRoot(new LoggerModuleConfig(AppNameEnum.RETAIL_MICROSERVICE)),
    DatabaseModule.forRoot([...cartEntities, ...orderEntities]),
    CartModule,
    OrdersModule,
  ],
})
export class AppModule {}
