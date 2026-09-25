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
