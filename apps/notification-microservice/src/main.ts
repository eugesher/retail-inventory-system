import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { MicroserviceOptions, Transport } from '@nestjs/microservices';
import { Logger, PinoLogger } from 'nestjs-pino';

import { MicroserviceQueueEnum, AppNameEnum } from '@retail-inventory-system/common';
import { LoggerConfig } from '@retail-inventory-system/config';
import { AppModule } from './app';

((): void => {
  const logger = new Logger(
    new PinoLogger(new LoggerConfig(AppNameEnum.NOTIFICATION_MICROSERVICE)),
    {},
  );
  const loggerContext = 'NotificationMicroserviceBootstrap';

  void (async (): Promise<void> => {
    const configService = new ConfigService();

    const app = await NestFactory.createMicroservice<MicroserviceOptions>(AppModule, {
      logger,
      transport: Transport.RMQ,
      options: {
        urls: [configService.get<string>('RABBITMQ_URL')!],
        noAck: false,
        queue: MicroserviceQueueEnum.NOTIFICATION_EVENTS,
        queueOptions: { durable: true },
      },
    });

    app.useLogger(app.get(Logger));

    await app.listen();

    logger.log({ context: loggerContext, message: 'Microservice is listening for messages' });
  })().catch((e: Error) => {
    logger.error({ context: loggerContext, message: e.message, stack: e.stack });

    process.exit(1);
  });
})();
