import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { ClientsModule, Transport } from '@nestjs/microservices';

import { MicroserviceClientNameEnum, MicroserviceClientQueueEnum } from '@retail-inventory/common';

@Module({
  imports: [
    ConfigModule,
    ClientsModule.registerAsync([
      {
        name: MicroserviceClientNameEnum.INVENTORY_SERVICE,
        useFactory: (configService: ConfigService) => ({
          transport: Transport.RMQ,
          options: {
            urls: [configService.get<string>('RABBITMQ_URL')!],
            queue: MicroserviceClientQueueEnum.INVENTORY_QUEUE,
            queueOptions: {
              durable: true,
            },
          },
        }),
        inject: [ConfigService],
      },
      {
        name: MicroserviceClientNameEnum.ORDER_SERVICE,
        useFactory: (configService: ConfigService) => ({
          transport: Transport.RMQ,
          options: {
            urls: [configService.get<string>('RABBITMQ_URL')!],
            queue: MicroserviceClientQueueEnum.ORDER_QUEUE,
            queueOptions: {
              durable: true,
            },
          },
        }),
        inject: [ConfigService],
      },
      {
        name: MicroserviceClientNameEnum.NOTIFICATION_SERVICE,
        useFactory: (configService: ConfigService) => ({
          transport: Transport.RMQ,
          options: {
            urls: [configService.get<string>('RABBITMQ_URL')!],
            queue: MicroserviceClientQueueEnum.NOTIFICATION_EVENTS,
            queueOptions: {
              durable: true,
            },
          },
        }),
        inject: [ConfigService],
      },
    ]),
  ],
  exports: [ClientsModule],
})
export class MicroserviceClientsModule {}
