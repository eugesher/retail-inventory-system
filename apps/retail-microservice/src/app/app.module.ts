import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { LoggerModule } from 'nestjs-pino';

import { configModuleConfig } from '@retail-inventory-system/config';
import { AppNameEnum } from '@retail-inventory-system/contracts';
import { DatabaseModule } from '@retail-inventory-system/database';
import { LoggerModuleConfig } from '@retail-inventory-system/observability';

import { CartModule, cartEntities } from '../modules/cart';
import { OrdersModule, orderEntities } from '../modules/orders';

// The retail microservice owns the rebuilt checkout context. The `cart` module
// carries the mutable `Cart`/`CartLine` aggregate plus the six cart command RPCs;
// the `orders` module carries the immutable `Order`/`OrderLine`, the polymorphic
// `Address`, and the `Payment` aggregates plus the place / capture / read RPCs —
// ten `@MessagePattern` handlers in total, all served off `retail_queue` (ADR-028).
// `DatabaseModule.forRoot` opens the one MySQL connection the context's modules
// share — `cartEntities` + `orderEntities` are concrete entity arrays, merged into
// one list.
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
