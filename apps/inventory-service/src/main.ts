import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
// import { ConfigService } from '@nestjs/config';
import { MicroserviceOptions, Transport } from '@nestjs/microservices';

import { AppModule } from './app';

async function bootstrap() {
  const app = await NestFactory.createMicroservice<MicroserviceOptions>(AppModule, {
    transport: Transport.RMQ,
    options: {
      urls: [process.env.RABBITMQ_URL ?? 'amqp://guest:guest@localhost:5672'],
      queue: 'inventory_queue',
      queueOptions: {
        durable: true,
      },
    },
  });

  // const configService = app.get(ConfigService);
  const logger = new Logger('InventoryService');

  await app.listen();
  logger.log('Inventory Microservice is listening for messages');
}

void bootstrap().catch((err) => {
  console.error('Inventory bootstrap failed', err);
  process.exit(1);
});
