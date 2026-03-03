import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ClientsModule } from '@nestjs/microservices';

import { MicroserviceClientConfiguration } from '../config';
import { MicroserviceClientTokenEnum, MicroserviceQueueEnum } from '../enums';

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
export class NotificationMicroserviceClientModule {}
