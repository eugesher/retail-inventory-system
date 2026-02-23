import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { MicroserviceOptions, Transport } from '@nestjs/microservices';

import { AppModule } from './app';
import { MicroserviceClientNameEnum, MicroserviceClientQueueEnum } from '@retail-inventory/common';

async function bootstrap() {
  const configService = new ConfigService();
  const app = await NestFactory.createMicroservice<MicroserviceOptions>(AppModule, {
    transport: Transport.RMQ,
    options: {
      urls: [configService.get<string>('RABBITMQ_URL')!],
      queue: MicroserviceClientQueueEnum.INVENTORY_QUEUE,
      queueOptions: {
        durable: true,
      },
    },
  });

  await app.listen();

  const logger = new Logger(MicroserviceClientNameEnum.INVENTORY_SERVICE);

  logger.log('Microservice is listening for messages');
}

void bootstrap().catch((err) => {
  console.error('Inventory bootstrap failed', err);
  process.exit(1);
});
