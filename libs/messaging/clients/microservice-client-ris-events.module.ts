import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { ClientsModule, RmqOptions, Transport } from '@nestjs/microservices';

import { MicroserviceClientTokenEnum } from '@retail-inventory-system/contracts';

import { EXCHANGES } from '../exchanges.constants';
import { RisEventsMirrorPublisher } from '../ris-events-mirror.publisher';

// The producer-side wiring for the `ris.events` topic exchange (ADR-035), and the one
// `MicroserviceClient*Module` that is not a default-exchange client.
//
// That changes what `emit`'s first argument MEANS. In the sibling modules it names a queue; here,
// with `exchangeType: 'topic'` and `wildcards: true`, it is the AMQP topic routing key and the
// message goes to `ris.events`. No queue is asserted on the producer side at all — the event
// store binds `event_store_firehose_queue` to the exchange with a catch-all `#` and dispatches
// from there.
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
