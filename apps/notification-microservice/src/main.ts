import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { MicroserviceOptions, Transport } from '@nestjs/microservices';

import { CleanBootstrapLogger, MicroserviceQueueEnum } from '@retail-inventory-system/common';
import { AppModule } from './app';

((): void => {
  const logger = new Logger('NotificationMicroserviceBootstrap');

  void (async (): Promise<void> => {
    const configService = new ConfigService();

    const app = await NestFactory.createMicroservice<MicroserviceOptions>(AppModule, {
      logger: new CleanBootstrapLogger(),
      transport: Transport.RMQ,
      options: {
        urls: [configService.get<string>('RABBITMQ_URL')!],
        noAck: false,
        queue: MicroserviceQueueEnum.NOTIFICATION_EVENTS,
        queueOptions: { durable: true },
      },
    });

    await app.listen();

    logger.log('Microservice is listening for messages');
  })().catch((e: Error) => {
    logger.error(e.message, e.stack);

    process.exit(1);
  });
})();
