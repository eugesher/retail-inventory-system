import '@retail-inventory-system/observability/tracer';

import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { MicroserviceOptions, Transport } from '@nestjs/microservices';
import { Logger, PinoLogger } from 'nestjs-pino';

import { MicroserviceQueueEnum, AppNameEnum } from '@retail-inventory-system/contracts';
import { LoggerModuleConfig } from '@retail-inventory-system/observability';
import { AppModule } from './app';

declare const module: {
  hot?: { accept(): void; dispose(callback: () => void | Promise<void>): void };
};

((): void => {
  const logger = new PinoLogger(new LoggerModuleConfig(AppNameEnum.EVENT_STORE_MICROSERVICE));

  void (async (): Promise<void> => {
    const configService = new ConfigService();

    // The event store boots as a plain RMQ listener on its own
    // `event_store_firehose_queue`, bound to the default exchange (the
    // `notification-microservice` shape). It registers NO `@MessagePattern` /
    // `@EventPattern` handlers yet, so it connects and idles. A later capability
    // re-points this connection at the `ris.events` topic exchange with `#.#`
    // wildcards so the queue receives the whole event firehose.
    const app = await NestFactory.createMicroservice<MicroserviceOptions>(AppModule, {
      bufferLogs: true,
      transport: Transport.RMQ,
      options: {
        urls: [configService.get<string>('RABBITMQ_URL')!],
        noAck: false,
        queue: MicroserviceQueueEnum.EVENT_STORE_FIREHOSE_QUEUE,
        queueOptions: { durable: true },
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
