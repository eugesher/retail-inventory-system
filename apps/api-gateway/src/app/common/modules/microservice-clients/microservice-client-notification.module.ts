import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ClientsModule } from '@nestjs/microservices';

import { MicroserviceClientNameEnum, MicroserviceQueueEnum } from '@retail-inventory/common';
import { MicroserviceClientOptions } from './config';

@Module({
  imports: [
    ConfigModule,
    ClientsModule.registerAsync([
      new MicroserviceClientOptions(
        MicroserviceClientNameEnum.NOTIFICATION_SERVICE,
        MicroserviceQueueEnum.NOTIFICATION_EVENTS,
      ),
    ]),
  ],
  exports: [ClientsModule],
})
export class MicroserviceClientNotificationModule {}
