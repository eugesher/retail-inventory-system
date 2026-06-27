import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { ClientsModule, RmqOptions, Transport } from '@nestjs/microservices';

import { MicroserviceClientTokenEnum } from '@retail-inventory-system/contracts';

import { EXCHANGES } from './exchanges.constants';
import { RisEventsMirrorPublisher } from './ris-events-mirror.publisher';

// The producer-side wiring for the `ris.events` topic exchange (ADR-035).
//
// Unlike the four per-service `MicroserviceClient*Module`s — each registers a
// default-exchange client whose `emit(pattern, payload)` publishes onto a queue
// named after `pattern` — this one configures the client for a **named topic
// exchange**: with `exchange: 'ris.events'`, `exchangeType: 'topic'`, and
// `wildcards: true`, `emit(routingKey, payload)` publishes to `ris.events`
// using `routingKey` as the AMQP topic routing key. No queue is asserted on the
// producer side; the event store binds the single `event_store_firehose_queue`
// with `#.#` (every event) and dispatches by routing key.
//
// The module exports both the registered `ClientsModule` (so consumers can
// inject the `RIS_EVENTS_PUBLISHER` `ClientProxy` directly — the real audit-log
// adapters do) and the shared `RisEventsMirrorPublisher` (the one place the
// mirror `emit` boilerplate lives, used by the domain-event publishers).
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
