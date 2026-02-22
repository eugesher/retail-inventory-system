import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
// import { ConfigService } from '@nestjs/config';
import { MicroserviceOptions, Transport } from '@nestjs/microservices';

import { AppModule } from './app';
import { MicroserviceClientQueueEnum } from '@retail-inventory/common';

async function bootstrap() {
  const app = await NestFactory.createMicroservice<MicroserviceOptions>(AppModule, {
    transport: Transport.RMQ,
    options: {
      urls: [process.env.RABBITMQ_URL ?? 'amqp://guest:guest@localhost:5672'],
      queue: MicroserviceClientQueueEnum.ORDER_QUEUE,
      queueOptions: {
        durable: true,
      },
    },
  });

  // const configService = app.get(ConfigService);
  const logger = new Logger('OrderService');

  await app.listen();
  logger.log('Order Microservice is listening for messages');
}

void bootstrap().catch((err) => {
  console.error('Order bootstrap failed', err);
  process.exit(1);
});
