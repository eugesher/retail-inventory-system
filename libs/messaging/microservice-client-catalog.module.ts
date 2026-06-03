import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ClientsModule } from '@nestjs/microservices';

import {
  MicroserviceClientTokenEnum,
  MicroserviceQueueEnum,
} from '@retail-inventory-system/contracts';

import { MicroserviceClientConfiguration } from './microservice-client.configuration';

// Registers a `ClientProxy` bound to `catalog_queue` under the
// `CATALOG_MICROSERVICE` token. The catalog microservice itself imports this
// module to publish its own events (`catalog.variant.created`) back onto
// `catalog_queue` — the events ride the same queue the service listens on; no
// consumer exists yet (a later inventory capability binds one), exactly the
// reserved-surface pattern `retail.order.confirmed` follows today.
@Module({
  imports: [
    ConfigModule,
    ClientsModule.registerAsync([
      new MicroserviceClientConfiguration(
        MicroserviceClientTokenEnum.CATALOG_MICROSERVICE,
        MicroserviceQueueEnum.CATALOG_QUEUE,
      ),
    ]),
  ],
  exports: [ClientsModule],
})
export class MicroserviceClientCatalogModule {}
