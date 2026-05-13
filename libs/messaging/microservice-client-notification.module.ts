import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ClientsModule } from '@nestjs/microservices';

import {
  MicroserviceClientTokenEnum,
  MicroserviceQueueEnum,
} from '@retail-inventory-system/contracts';

import { MicroserviceClientConfiguration } from './microservice-client.configuration';

// ClientProxy producer module for the notification microservice. Imported by
// any service that needs to emit cross-service events on the
// `notification_events` queue (e.g. `inventory.stock.low` from the inventory
// microservice, `retail.order.created` from retail in task-09).
@Module({
  imports: [
    ConfigModule,
    ClientsModule.registerAsync([
      new MicroserviceClientConfiguration(
        MicroserviceClientTokenEnum.NOTIFICATION_MICROSERVICE,
        MicroserviceQueueEnum.NOTIFICATION_EVENTS,
      ),
    ]),
  ],
  exports: [ClientsModule],
})
export class MicroserviceClientNotificationModule {}
