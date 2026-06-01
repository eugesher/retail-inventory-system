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
  const logger = new PinoLogger(new LoggerModuleConfig(AppNameEnum.CATALOG_MICROSERVICE));

  void (async (): Promise<void> => {
    const configService = new ConfigService();

    const app = await NestFactory.createMicroservice<MicroserviceOptions>(AppModule, {
      bufferLogs: true,
      transport: Transport.RMQ,
      options: {
        urls: [configService.get<string>('RABBITMQ_URL')!],
        queue: MicroserviceQueueEnum.CATALOG_QUEUE,
        queueOptions: { durable: true },
        noAck: false,
      },
    });

    app.useLogger(app.get(Logger));

    await app.listen();

    if (module.hot) {
      module.hot.accept();
      module.hot.dispose(() => app.close());
    }

    logger.info('Catalog Microservice is listening for messages');
  })().catch((e: Error) => {
    logger.error(e, 'Catalog Microservice bootstrap error');

    process.exit(1);
  });
})();
