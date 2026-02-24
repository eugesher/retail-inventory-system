import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { MicroserviceOptions, Transport } from '@nestjs/microservices';

import { MicroserviceQueueEnum } from '@retail-inventory/common';
import { AppModule } from './app';

((): void => {
  const logger = new Logger('InventoryServiceBootstrap');

  void (async (): Promise<void> => {
    const configService = new ConfigService();
    const app = await NestFactory.createMicroservice<MicroserviceOptions>(AppModule, {
      transport: Transport.RMQ,
      options: {
        urls: [configService.get<string>('RABBITMQ_URL')!],
        queue: MicroserviceQueueEnum.INVENTORY_QUEUE,
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
