import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { MicroserviceOptions, Transport } from '@nestjs/microservices';
import { Logger, PinoLogger } from 'nestjs-pino';

import { MicroserviceQueueEnum, AppNameEnum } from '@retail-inventory-system/common';
import { LoggerModuleConfig } from '@retail-inventory-system/config';
import { AppModule } from './app';

((): void => {
  const logger = new PinoLogger(new LoggerModuleConfig(AppNameEnum.INVENTORY_MICROSERVICE));

  void (async (): Promise<void> => {
    const configService = new ConfigService();

    const app = await NestFactory.createMicroservice<MicroserviceOptions>(AppModule, {
      bufferLogs: true,
      transport: Transport.RMQ,
      options: {
        urls: [configService.get<string>('RABBITMQ_URL')!],
        queue: MicroserviceQueueEnum.INVENTORY_QUEUE,
        queueOptions: { durable: true },
      },
    });

    app.useLogger(app.get(Logger));

    await app.listen();

    logger.info('Inventory Microservice is listening for messages');
  })().catch((e: Error) => {
    logger.error(e, 'Inventory Microservice bootstrap error');

    process.exit(1);
  });
})();
