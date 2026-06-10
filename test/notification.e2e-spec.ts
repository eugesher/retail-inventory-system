import { INestMicroservice } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import {
  ClientProxy,
  ClientProxyFactory,
  MicroserviceOptions,
  Transport,
} from '@nestjs/microservices';
import { firstValueFrom } from 'rxjs';

import { AppModule as NotificationMicroserviceAppModule } from '@retail-inventory-system/apps/notification-microservice';
import { IRetailOrderPlacedEvent, MicroserviceQueueEnum } from '@retail-inventory-system/contracts';
import { ROUTING_KEYS } from '@retail-inventory-system/messaging';

import { Notification } from '../apps/notification-microservice/src/modules/notifications/domain';
import { LogNotifierAdapter } from '../apps/notification-microservice/src/modules/notifications/infrastructure/delivery/log.notifier.adapter';

// Exercises the order-placed notification re-point in isolation: the consumer +
// use-case + notifier wiring is driven by publishing a synthetic
// `retail.order.placed` directly onto `notification_events`, bypassing the API
// gateway → retail path (which the cart-to-order walking skeleton covers). This
// proves the notification chain is whole again after the order-model rebuild —
// the same event the retail Place Order use case emits lands here and fans out.
describe('Notification flow (e2e)', () => {
  const timeout = 60_000;

  let notificationMicroservice: INestMicroservice;
  let publisher: ClientProxy;
  let sendSpy: jest.SpyInstance<Promise<void>, [Notification]>;

  beforeAll(async () => {
    // `spyOn` (not `jest.fn()`) keeps the LogNotifierAdapter.send() body running.
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

  it('dispatches a notification when a synthetic retail.order.placed lands on the queue', async () => {
    const event: IRetailOrderPlacedEvent = {
      correlationId: 'e2e-corr-order-1',
      orderId: 4242,
      orderNumber: 'ORD-2026-00004242',
      customerId: '11111111-1111-4111-8111-111111111111',
      grandTotalMinor: 29997,
      currency: 'USD',
      lineCount: 2,
      eventVersion: 'v1',
      occurredAt: '2026-06-10T14:00:00.000Z',
    };

    // `firstValueFrom` triggers the cold emit and awaits broker ack.
    await firstValueFrom(publisher.emit(ROUTING_KEYS.RETAIL_ORDER_PLACED, event));

    await waitForCall(() => sendSpy.mock.calls.length > 0);

    const sent = sendSpy.mock.calls[0][0];
    expect(sent.recipient).toBe('order:4242');
    expect(sent.subject).toContain('ORD-2026-00004242');
    expect(sent.body).toContain('ORD-2026-00004242');
    expect(sent.metadata).toMatchObject({
      orderId: 4242,
      orderNumber: 'ORD-2026-00004242',
      grandTotalMinor: 29997,
      currency: 'USD',
      lineCount: 2,
    });
  });
});
