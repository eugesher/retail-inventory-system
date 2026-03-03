import { ConfigService } from '@nestjs/config';
import { ClientsProviderAsyncOptions, RmqOptions, Transport } from '@nestjs/microservices';

import { MicroserviceClientTokenEnum, MicroserviceQueueEnum } from '../enums';

export class MicroserviceClientConfiguration implements ClientsProviderAsyncOptions {
  public readonly useFactory: ClientsProviderAsyncOptions['useFactory'];

  public readonly inject = [ConfigService];

  constructor(
    public readonly name: MicroserviceClientTokenEnum,
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
