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
        MicroserviceClientTokenEnum.RETAIL_MICROSERVICE,
        MicroserviceQueueEnum.RETAIL_QUEUE,
      ),
    ]),
  ],
  exports: [ClientsModule],
})
export class MicroserviceClientRetailModule {}
