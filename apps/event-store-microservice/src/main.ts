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

    // The event store binds its durable `event_store_firehose_queue` to the `ris.events`
    // TOPIC exchange (ADR-035) — not the default exchange. With `exchangeType: 'topic'`
    // + `wildcards: true`, the `FirehoseConsumer`'s `@EventPattern('#')` becomes the AMQP
    // binding routing key (`#` is the catch-all that routes EVERY key), so the one queue
    // receives the whole firehose and the consumer dispatches by the concrete routing key.
    // `noAck: false` keeps at-least-once delivery; the consumer never rethrows, so a
    // message is always acked (ADR-011 §7).
    const app = await NestFactory.createMicroservice<MicroserviceOptions>(AppModule, {
      bufferLogs: true,
      transport: Transport.RMQ,
      options: {
        urls: [configService.get<string>('RABBITMQ_URL')!],
        noAck: false,
        queue: MicroserviceQueueEnum.EVENT_STORE_FIREHOSE_QUEUE,
        queueOptions: { durable: true },
        exchange: EXCHANGES.RIS_EVENTS_TOPIC,
        exchangeType: 'topic',
        wildcards: true,
      },
    });

    app.useLogger(app.get(Logger));

    await app.listen();

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
