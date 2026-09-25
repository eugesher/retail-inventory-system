import { randomUUID } from 'node:crypto';

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
import {
  INotificationTemplateAuthorPayload,
  IRetailOrderPlacedEvent,
  MicroserviceQueueEnum,
  NotificationChannelEnum,
} from '@retail-inventory-system/contracts';
import { ROUTING_KEYS } from '@retail-inventory-system/messaging';

import { Notification } from '../apps/notification-microservice/src/modules/notifications/domain';
import { LogNotifierAdapter } from '../apps/notification-microservice/src/modules/notifications/infrastructure/delivery/log.notifier.adapter';

describe('Notification flow (e2e)', () => {
  const timeout = 60_000;

  const RECIPIENT_EMAIL = 'buyer-e2e@example.com';
  const CUSTOMER_ID = randomUUID();

  let notificationMicroservice: INestMicroservice;
  let publisher: ClientProxy;
  let sendSpy: jest.SpyInstance<Promise<void>, [Notification]>;

  beforeAll(async () => {
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

    const authorPayload: INotificationTemplateAuthorPayload = {
      correlationId: 'e2e-author-order-placed',
      eventType: ROUTING_KEYS.RETAIL_ORDER_PLACED,
      channel: NotificationChannelEnum.EMAIL,
      locale: 'en-US',
      subject: 'Order {{orderNumber}} placed',
      body: 'Order {{orderNumber}} totaling {{grandTotalMinor}} {{currency}} across {{lineCount}} lines.',
    };
    await firstValueFrom(publisher.send(ROUTING_KEYS.NOTIFICATION_TEMPLATE_AUTHOR, authorPayload));
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

  it('renders and dispatches a notification when a synthetic retail.order.placed lands on the queue', async () => {
    const event: IRetailOrderPlacedEvent = {
      correlationId: 'e2e-corr-order-1',
      orderId: 4242,
      orderNumber: 'ORD-2026-00004242',
      customerId: CUSTOMER_ID,
      customerEmail: RECIPIENT_EMAIL,
      customerLocale: null,
      grandTotalMinor: 29997,
      currency: 'USD',
      lineCount: 2,
      eventVersion: 'v1',
      occurredAt: '2026-06-10T14:00:00.000Z',
    };

    await firstValueFrom(publisher.emit(ROUTING_KEYS.RETAIL_ORDER_PLACED, event));

    await waitForCall(() => sendSpy.mock.calls.length > 0);

    const sent = sendSpy.mock.calls[0][0];
    expect(sent.recipient).toBe(RECIPIENT_EMAIL);
    expect(sent.channel).toBe(NotificationChannelEnum.EMAIL);
    expect(sent.subject).toContain('ORD-2026-00004242');
    expect(sent.body).toContain('ORD-2026-00004242');
    expect(sent.body).toContain('29997');
    expect(sent.body).toContain('USD');
    expect(sent.metadata).toMatchObject({
      eventType: ROUTING_KEYS.RETAIL_ORDER_PLACED,
      eventReferenceType: 'order',
      eventReferenceId: '4242',
      correlationId: 'e2e-corr-order-1',
    });
    expect(sent.metadata).toHaveProperty('deliveryId');
  });
});
