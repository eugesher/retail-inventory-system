import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { LoggerModule } from 'nestjs-pino';

import { configModuleConfig } from '@retail-inventory-system/config';
import { AppNameEnum } from '@retail-inventory-system/contracts';
import { DatabaseModule } from '@retail-inventory-system/database';
import { LoggerModuleConfig } from '@retail-inventory-system/observability';

import { notificationEntities, NotificationsModule } from '../modules/notifications';

// The notification microservice gains its first database here (ADR-033): it shares the
// one `retail_db`, so `DatabaseModule.forRoot` opens the same connection the other
// services use (the inventory `app.module.ts` shape). `synchronize` is off — the
// `notification_template` / `notification_delivery` schema is owned by the migration.
@Module({
  imports: [
    ConfigModule.forRoot(configModuleConfig),
    LoggerModule.forRoot(new LoggerModuleConfig(AppNameEnum.NOTIFICATION_MICROSERVICE)),
    DatabaseModule.forRoot(notificationEntities),
    NotificationsModule,
  ],
})
export class AppModule {}
