import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { LoggerModule } from 'nestjs-pino';

import { configModuleConfig } from '@retail-inventory-system/config';
import { AppNameEnum } from '@retail-inventory-system/contracts';
import { DatabaseModule } from '@retail-inventory-system/database';
import { LoggerModuleConfig } from '@retail-inventory-system/observability';

import { CartModule, cartEntities } from '../modules/cart';

// The retail microservice owns the rebuilt checkout context. The `cart` module's
// `Cart`/`CartLine` aggregate is registered first; the immutable `Order` + the
// `Payment` aggregate land in later capabilities. `DatabaseModule.forRoot` opens
// the one MySQL connection the context's modules share — `cartEntities` is typed
// `TypeOrmModuleOptions['entities']` (a `MixedList` the type system also allows to
// be an object map or `undefined`, neither of which can be spread), so it is
// passed through directly. No cart `@MessagePattern` / `@EventPattern` handlers
// exist yet — the cart operations + their gateway arrive with a later capability,
// so the service still listens on `retail_queue` with no handlers.
@Module({
  imports: [
    ConfigModule.forRoot(configModuleConfig),
    LoggerModule.forRoot(new LoggerModuleConfig(AppNameEnum.RETAIL_MICROSERVICE)),
    DatabaseModule.forRoot(cartEntities),
    CartModule,
  ],
})
export class AppModule {}
