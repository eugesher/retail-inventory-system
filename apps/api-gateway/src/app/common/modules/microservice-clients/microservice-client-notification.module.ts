import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ClientsModule } from '@nestjs/microservices';

import { MicroserviceClientNameEnum, MicroserviceQueueEnum } from '@retail-inventory-system/common';
import { MicroserviceClientConfiguration } from './config';

@Module({
  imports: [
    ConfigModule,
    ClientsModule.registerAsync([
      new MicroserviceClientConfiguration(
        MicroserviceClientNameEnum.NOTIFICATION_SERVICE,
        MicroserviceQueueEnum.NOTIFICATION_EVENTS,
      ),
    ]),
  ],
  exports: [ClientsModule],
})
export class MicroserviceClientNotificationModule {}
