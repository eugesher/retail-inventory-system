import { INestMicroservice } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import {
  ClientProxy,
  ClientProxyFactory,
  MicroserviceOptions,
  Transport,
} from '@nestjs/microservices';

import { AppModule as NotificationMicroserviceAppModule } from '@retail-inventory-system/apps/notification-microservice';
import {
  IRetailOrderCreatedEvent,
  MicroserviceQueueEnum,
  OrderStatusEnum,
} from '@retail-inventory-system/contracts';
import { ROUTING_KEYS } from '@retail-inventory-system/messaging';
import { firstValueFrom } from 'rxjs';

import { Notification } from '../apps/notification-microservice/src/modules/notifications/domain';
import { LogNotifierAdapter } from '../apps/notification-microservice/src/modules/notifications/infrastructure/delivery/log.notifier.adapter';

// E2E smoke test for the notification microservice. Publishes a synthetic
// `retail.order.created` event onto the `notification_events` queue and
// asserts the LogNotifierAdapter received a Notification carrying the order
// id. The full retail → notification path comes online in task-09; this
// test exercises the consumer + use-case + notifier wiring in isolation.
describe('Notification flow (e2e)', () => {
  const timeout = 60_000;

  let notificationMicroservice: INestMicroservice;
  let publisher: ClientProxy;
  let sendSpy: jest.SpyInstance<Promise<void>, [Notification]>;

  beforeAll(async () => {
    // jest.spyOn keeps the original implementation (so the Pino info line is
    // still emitted) and records every call for inspection.
    sendSpy = jest.spyOn(LogNotifierAdapter.prototype, 'send');

    const rmqUrl = process.env.RABBITMQ_URL!;

    notificationMicroservice = await NestFactory.createMicroservice<MicroserviceOptions>(
      NotificationMicroserviceAppModule,
      {
        logger: false,
        transport: Transport.RMQ,
        options: {
          urls: [rmqUrl],
          queue: MicroserviceQueueEnum.NOTIFICATION_EVENTS,
          queueOptions: { durable: true },
        },
      },
    );

    await notificationMicroservice.listen();

    publisher = ClientProxyFactory.create({
      transport: Transport.RMQ,
      options: {
        urls: [rmqUrl],
        queue: MicroserviceQueueEnum.NOTIFICATION_EVENTS,
        queueOptions: { durable: true },
      },
    });
    await publisher.connect();
  }, timeout);

  afterAll(async () => {
    await publisher?.close();
    await notificationMicroservice?.close();
    sendSpy?.mockRestore();
  });

  beforeEach(() => {
    sendSpy.mockClear();
  });

  const waitForCall = async (predicate: () => boolean, deadlineMs = 5_000): Promise<void> => {
    const start = Date.now();
    while (!predicate()) {
      if (Date.now() - start > deadlineMs) {
        throw new Error('Timed out waiting for notifier.send()');
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  };

  it('dispatches a notification when a synthetic retail.order.created lands on the queue', async () => {
    const event: IRetailOrderCreatedEvent = {
      correlationId: 'e2e-corr-1',
      orderId: 4242,
      customerId: 7,
      status: OrderStatusEnum.PENDING,
      products: [{ productId: 1, quantity: 2 }],
      occurredAt: '2026-05-13T14:00:00.000Z',
    };

    // `client.emit()` returns a cold observable — without subscription no
    // bytes leave the publisher. `firstValueFrom` triggers the emit and
    // resolves once the broker has acknowledged the publish.
    await firstValueFrom(publisher.emit(ROUTING_KEYS.RETAIL_ORDER_CREATED, event));

    await waitForCall(() => sendSpy.mock.calls.length > 0);

    const sent = sendSpy.mock.calls[0][0];
    expect(sent.metadata).toMatchObject({ orderId: 4242, customerId: 7 });
    expect(sent.subject).toContain('4242');
    expect(sent.body).toContain('4242');
  });
});
