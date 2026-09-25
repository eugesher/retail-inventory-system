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

    const app = await NestFactory.create(AppModule, { bufferLogs: true });

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
