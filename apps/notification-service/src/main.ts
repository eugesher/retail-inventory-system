import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { MicroserviceOptions, Transport } from '@nestjs/microservices';

import { AppModule } from './app';

async function bootstrap() {
  const app = await NestFactory.createMicroservice<MicroserviceOptions>(AppModule, {
    transport: Transport.RMQ,
    options: {
      urls: [process.env.RABBITMQ_URL ?? 'amqp://guest:guest@localhost:5672'],
      noAck: false,
      queue: 'notification_events',
      queueOptions: {
        durable: true,
      },
    },
  });

  const logger = new Logger('NotificationService');
  await app.listen();
  logger.log('Notification Worker is listening for events');
}

bootstrap().catch((err) => {
  console.error('Notification bootstrap failed', err);
  process.exit(1);
});
