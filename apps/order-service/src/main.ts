import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { MicroserviceOptions, Transport } from '@nestjs/microservices';

import { MicroserviceQueueEnum } from '@retail-inventory/common';
import { AppModule } from './app';

((): void => {
  const logger = new Logger('OrderServiceBootstrap');

  void (async (): Promise<void> => {
    const app = await NestFactory.createMicroservice<MicroserviceOptions>(AppModule, {
      transport: Transport.RMQ,
      options: {
        urls: [process.env.RABBITMQ_URL ?? 'amqp://guest:guest@localhost:5672'],
        queue: MicroserviceQueueEnum.ORDER_QUEUE,
        queueOptions: {
          durable: true,
        },
      },
    });

    await app.listen();

    logger.log('Microservice is listening for messages');
  })().catch((e: Error) => {
    logger.error(e.message, e.stack);

    process.exit(1);
  });
})();
