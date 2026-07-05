import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { LoggerModule } from 'nestjs-pino';

import { CacheModule } from '@retail-inventory-system/cache';
import { configModuleConfig } from '@retail-inventory-system/config';
import { AppNameEnum } from '@retail-inventory-system/contracts';
import { DatabaseModule } from '@retail-inventory-system/database';
import { LoggerModuleConfig } from '@retail-inventory-system/observability';

import { notificationEntities, NotificationsModule } from '../modules/notifications';

// The notification microservice gains its first database here (ADR-033): it shares the
// one `retail_db`, so `DatabaseModule.forRoot` opens the same connection the other
// services use (the inventory `app.module.ts` shape). `synchronize` is off — the
// `notification_template` / `notification_delivery` schema is owned by the migration.
//
// `CacheModule` is wired here for the FIRST time in this service (ADR-037): the
// `@Global()` Redis cache backs the notification consent cache, which the Render &
// Dispatch consent-gate reads per customer-facing dispatch to avoid a per-delivery DB
// hit (the gateway/inventory `CacheModule`-at-root precedent). It reuses the shared
// `REDIS_URL` env the compose block already sets.
@Module({
  imports: [
    ConfigModule.forRoot(configModuleConfig),
    LoggerModule.forRoot(new LoggerModuleConfig(AppNameEnum.NOTIFICATION_MICROSERVICE)),
    CacheModule,
    DatabaseModule.forRoot(notificationEntities),
    NotificationsModule,
  ],
})
export class AppModule {}
