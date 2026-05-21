import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ClientsModule } from '@nestjs/microservices';

import {
  MicroserviceClientTokenEnum,
  MicroserviceQueueEnum,
} from '@retail-inventory-system/contracts';

import { MicroserviceClientConfiguration } from './microservice-client.configuration';

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
