import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ClientsModule } from '@nestjs/microservices';

import {
  MicroserviceClientTokenEnum,
  MicroserviceQueueEnum,
} from '@retail-inventory-system/contracts';

import { MicroserviceClientConfiguration } from '../clients/microservice-client.configuration';

// Registers a `ClientProxy` bound to `catalog_queue` under the `CATALOG_MICROSERVICE` token.
// The catalog service imports it to emit `catalog.product.published` / `.archived` onto its own
// queue, where nothing is bound — reserved surfaces (README §2).
//
// `catalog.variant.created` does NOT ride this client. It targets the inventory consumer's queue
// (ADR-008/020), which is why `CatalogRabbitmqPublisher` holds a second, inventory-bound client
// beside this one.
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
