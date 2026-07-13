import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import {
  MicroserviceClientCatalogModule,
  MicroserviceClientEventStoreModule,
  MicroserviceClientInventoryModule,
  MicroserviceClientNotificationModule,
  MicroserviceClientRetailModule,
} from '@retail-inventory-system/messaging';

import { HEALTH_GATEWAY_PORT, HEALTH_PROBE_TIMEOUT_MS } from './application/ports';
import { CheckHealthUseCase } from './application/use-cases';
import { HealthRabbitmqAdapter } from './infrastructure/messaging';
import { HealthController } from './presentation';

// The liveness fan-out module (ADR-044). It is the only gateway module that imports **every**
// `MicroserviceClient*Module`, because it is the only one that talks to every service —
// every other module fronts exactly one.
//
// `HEALTH_PROBE_TIMEOUT_MS` bounds a single probe (Joi default 2000). It is a value provider,
// not a `process.env` read: the use case and the adapter receive a plain `number`.
@Module({
  imports: [
    MicroserviceClientCatalogModule,
    MicroserviceClientInventoryModule,
    MicroserviceClientRetailModule,
    MicroserviceClientNotificationModule,
    MicroserviceClientEventStoreModule,
  ],
  controllers: [HealthController],
  providers: [
    {
      provide: HEALTH_PROBE_TIMEOUT_MS,
      inject: [ConfigService],
      useFactory: (config: ConfigService): number =>
        config.get<number>('HEALTH_PROBE_TIMEOUT_MS', 2000),
    },
    { provide: HEALTH_GATEWAY_PORT, useClass: HealthRabbitmqAdapter },
    CheckHealthUseCase,
  ],
})
export class HealthModule {}
