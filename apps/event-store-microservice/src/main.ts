import '@retail-inventory-system/observability/tracer';

import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { MicroserviceOptions, Transport } from '@nestjs/microservices';
import { Logger, PinoLogger } from 'nestjs-pino';

import { MicroserviceQueueEnum, AppNameEnum } from '@retail-inventory-system/contracts';
import { EXCHANGES } from '@retail-inventory-system/messaging';
import { LoggerModuleConfig } from '@retail-inventory-system/observability';
import { AppModule } from './app';

declare const module: {
  hot?: { accept(): void; dispose(callback: () => void | Promise<void>): void };
};

((): void => {
  const logger = new PinoLogger(new LoggerModuleConfig(AppNameEnum.EVENT_STORE_MICROSERVICE));

  void (async (): Promise<void> => {
    const configService = new ConfigService();
    const rabbitmqUrl = configService.get<string>('RABBITMQ_URL')!;

    // The event store connects TWO RabbitMQ transports (ADR-039), so it cannot use
    // `NestFactory.createMicroservice`: that returns an `INestMicroservice`, which has no
    // `connectMicroservice`. The hybrid `NestFactory.create` form is the only shape Nest
    // offers for a second transport — and it instantiates an HTTP adapter that binds no
    // TCP port until `listen()` is called. This service never calls `listen()`.
    const app = await NestFactory.create(AppModule, { bufferLogs: true });

    // Transport 1 — ingest. The durable `event_store_firehose_queue` binds the `ris.events`
    // TOPIC exchange (ADR-035), not the default exchange. With `exchangeType: 'topic'` +
    // `wildcards: true`, the `FirehoseConsumer`'s `@EventPattern('#')` becomes the AMQP
    // binding routing key (`#` is the catch-all that routes EVERY key), so the one queue
    // receives the whole firehose and the consumer dispatches by the concrete routing key.
    // `noAck: false` keeps at-least-once delivery; the consumer never rethrows, so a
    // message is always acked (ADR-011 §7).
    //
    // Because `ServerRMQ.listen()` binds EVERY registered handler pattern as a routing key
    // when `wildcards` is on, this queue additionally gains three inert `audit.*.query`
    // bindings on `ris.events`. Nothing publishes those keys to that exchange.
    app.connectMicroservice<MicroserviceOptions>(
      {
        transport: Transport.RMQ,
        options: {
          urls: [rabbitmqUrl],
          noAck: false,
          queue: MicroserviceQueueEnum.EVENT_STORE_FIREHOSE_QUEUE,
          queueOptions: { durable: true },
          exchange: EXCHANGES.RIS_EVENTS_TOPIC,
          exchangeType: 'topic',
          wildcards: true,
        },
      },
      { inheritAppConfig: true },
    );

    // Transport 2 — query. A plain default-exchange RPC queue, configured exactly like
    // every other service's `@MessagePattern` transport: no `exchange`, no `wildcards`.
    // With `wildcards` off, `ServerRMQ.getHandlerByPattern` is an exact map lookup, so the
    // `@EventPattern('#')` this same app also registers is an unreachable literal key here
    // and `audit.event.query` resolves to its `@MessagePattern` handler (ADR-039 §3).
    app.connectMicroservice<MicroserviceOptions>(
      {
        transport: Transport.RMQ,
        options: {
          urls: [rabbitmqUrl],
          queue: MicroserviceQueueEnum.EVENT_STORE_QUERY_QUEUE,
          queueOptions: { durable: true },
        },
      },
      { inheritAppConfig: true },
    );

    app.useLogger(app.get(Logger));

    // `connectMicroservice` marks each `NestMicroservice` initialized, so their `listen()`
    // skips the lifecycle hooks. `app.init()` is what actually runs `onModuleInit` /
    // `onApplicationBootstrap` — and it runs FIRST, so the `ris_eventstore` connection is
    // open before either queue starts delivering messages.
    await app.init();
    await app.startAllMicroservices();

    if (module.hot) {
      module.hot.accept();
      module.hot.dispose(() => app.close());
    }

    logger.info('Event Store Microservice is listening for messages');
  })().catch((e: Error) => {
    logger.error(e, 'Event Store Microservice bootstrap error');

    process.exit(1);
  });
})();
