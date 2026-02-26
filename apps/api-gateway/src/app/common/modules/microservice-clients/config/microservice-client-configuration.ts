import { ConfigService } from '@nestjs/config';
import { ClientsProviderAsyncOptions, RmqOptions, Transport } from '@nestjs/microservices';

import { MicroserviceClientNameEnum, MicroserviceQueueEnum } from '@retail-inventory-system/common';

export class MicroserviceClientConfiguration implements ClientsProviderAsyncOptions {
  public readonly useFactory: ClientsProviderAsyncOptions['useFactory'];

  public readonly inject = [ConfigService];

  constructor(
    public readonly name: MicroserviceClientNameEnum,
    queue: MicroserviceQueueEnum,
  ) {
    this.useFactory = (configService: ConfigService): RmqOptions => ({
      transport: Transport.RMQ,
      options: {
        urls: [configService.get<string>('RABBITMQ_URL')!],
        queueOptions: { durable: true },
        queue,
      },
    });
  }
}
