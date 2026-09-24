import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { ClientsModule, RmqOptions, Transport } from '@nestjs/microservices';

import { MicroserviceClientTokenEnum } from '@retail-inventory-system/contracts';

import { EXCHANGES } from '../exchanges.constants';
import { RisEventsMirrorPublisher } from '../ris-events-mirror.publisher';

@Module({
  imports: [
    ConfigModule,
    ClientsModule.registerAsync([
      {
        name: MicroserviceClientTokenEnum.RIS_EVENTS_PUBLISHER,
        imports: [ConfigModule],
        inject: [ConfigService],
        useFactory: (configService: ConfigService): RmqOptions => ({
          transport: Transport.RMQ,
          options: {
            urls: [configService.get<string>('RABBITMQ_URL')!],
            exchange: EXCHANGES.RIS_EVENTS_TOPIC,
            exchangeType: 'topic',
            wildcards: true,
            queueOptions: { durable: true },
          },
        }),
      },
    ]),
  ],
  providers: [RisEventsMirrorPublisher],
  exports: [ClientsModule, RisEventsMirrorPublisher],
})
export class MicroserviceClientRisEventsModule {}
