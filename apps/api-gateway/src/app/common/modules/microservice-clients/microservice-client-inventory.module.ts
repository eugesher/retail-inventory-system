import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ClientsModule } from '@nestjs/microservices';

import { MicroserviceClientNameEnum, MicroserviceQueueEnum } from '@retail-inventory/common';
import { MicroserviceClientConfiguration } from './config';

@Module({
  imports: [
    ConfigModule,
    ClientsModule.registerAsync([
      new MicroserviceClientConfiguration(
        MicroserviceClientNameEnum.INVENTORY_SERVICE,
        MicroserviceQueueEnum.INVENTORY_QUEUE,
      ),
    ]),
  ],
  exports: [ClientsModule],
})
export class MicroserviceClientInventoryModule {}
