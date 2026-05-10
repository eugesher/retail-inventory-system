import { ConfigService } from '@nestjs/config';
import { ClientProxy, ClientProxyFactory, RmqOptions, Transport } from '@nestjs/microservices';

import { MicroserviceQueueEnum } from '@retail-inventory-system/contracts';

// Factory for building a `ClientProxy` against a queue. Used by callers that
// want a one-off proxy without registering a Nest provider (tests, bootstrap
// scripts). For typical app-module wiring use `MicroserviceClient*Module`.
export class RabbitmqClientFactory {
  public static create(configService: ConfigService, queue: MicroserviceQueueEnum): ClientProxy {
    const options: RmqOptions = {
      transport: Transport.RMQ,
      options: {
        urls: [configService.get<string>('RABBITMQ_URL')!],
        queueOptions: { durable: true },
        queue,
      },
    };
    return ClientProxyFactory.create(options);
  }
}
