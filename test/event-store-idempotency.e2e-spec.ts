import { randomUUID } from 'crypto';

import { INestMicroservice } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import {
  ClientProxy,
  ClientProxyFactory,
  MicroserviceOptions,
  Transport,
} from '@nestjs/microservices';
import { firstValueFrom } from 'rxjs';

import { AppModule as EventStoreMicroserviceAppModule } from '@retail-inventory-system/apps/event-store-microservice';
import { MicroserviceQueueEnum } from '@retail-inventory-system/contracts';

import { EventStoreE2ESpecDataSource } from './data-source/event-store.e2e-spec.data-source';

const EVENT_TYPE = 'retail.order.placed';
const PRODUCER = 'retail-microservice';

interface ICraftedEvent {
  orderId: number;
  eventVersion: 'v1';
  occurredAt: string;
  correlationId: string;
}

const toMysqlDatetime = (iso: string): string => iso.replace('T', ' ').replace('Z', '');

describe('Event store firehose idempotency and no-loss fan-out (e2e)', () => {
  const timeout = 90_000;

  let eventStoreMicroservice: INestMicroservice;
  let publisher: ClientProxy;
  let eventStore: EventStoreE2ESpecDataSource;

  const emit = (payload: ICraftedEvent): Promise<void> =>
    firstValueFrom(publisher.emit<void, ICraftedEvent>(EVENT_TYPE, payload));

  beforeAll(async () => {
    const rmqUrl = process.env.RABBITMQ_URL!;

    eventStoreMicroservice = await NestFactory.createMicroservice<MicroserviceOptions>(
      EventStoreMicroserviceAppModule,
      {
        logger: false,
        transport: Transport.RMQ,
        options: {
          urls: [rmqUrl],
          noAck: false,
          queue: MicroserviceQueueEnum.EVENT_STORE_FIREHOSE_QUEUE,
          queueOptions: { durable: true },
          exchange: 'ris.events',
          exchangeType: 'topic',
          wildcards: true,
        },
      },
    );
    await eventStoreMicroservice.listen();

    publisher = ClientProxyFactory.create({
      transport: Transport.RMQ,
      options: {
        urls: [rmqUrl],
        exchange: 'ris.events',
        exchangeType: 'topic',
        wildcards: true,
        queueOptions: { durable: true },
      },
    });
    await publisher.connect();

    eventStore = new EventStoreE2ESpecDataSource({
      type: 'mysql',
      url: process.env.EVENTSTORE_DATABASE_URL!,
      timezone: 'Z',
    });
    await eventStore.initialize();
  }, timeout);

  afterAll(async () => {
    await publisher?.close();
    await eventStoreMicroservice?.close();
    await eventStore?.destroy();
  });

  const waitForCount = async (
    read: () => Promise<number>,
    expected: number,
    deadlineMs: number,
  ): Promise<number> => {
    const start = Date.now();
    let last = await read();
    while (last < expected) {
      if (Date.now() - start > deadlineMs) {
        return last;
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
      last = await read();
    }
    return last;
  };

  it('collapses a double-published event to exactly one domain_event row', async () => {
    const correlationId = `idem-${Date.now()}-${randomUUID()}`;
    const occurredAt = '2026-06-28T09:15:30.500Z';
    const event: ICraftedEvent = {
      orderId: Date.now(),
      eventVersion: 'v1',
      occurredAt,
      correlationId,
    };

    await emit(event);
    await emit(event);

    const landed = await waitForCount(
      () => eventStore.countDomainEventsByCorrelationId(correlationId),
      1,
      30_000,
    );
    expect(landed).toBe(1);

    await new Promise((resolve) => setTimeout(resolve, 1_000));

    const byComposite = await eventStore.countDomainEventsByCompositeKey({
      producer: PRODUCER,
      eventType: EVENT_TYPE,
      aggregateId: String(event.orderId),
      occurredAt: toMysqlDatetime(occurredAt),
      correlationId,
    });
    expect(byComposite).toBe(1);
    expect(await eventStore.countDomainEventsByCorrelationId(correlationId)).toBe(1);
  });

  it('loses nothing under a concurrent 100-event burst', async () => {
    const correlationId = `burst-${Date.now()}-${randomUUID()}`;
    const baseOrderId = Date.now();
    const baseTime = Date.parse('2026-06-28T10:00:00.000Z');

    const events: ICraftedEvent[] = Array.from({ length: 100 }, (_, i) => ({
      orderId: baseOrderId + i,
      eventVersion: 'v1',
      occurredAt: new Date(baseTime + i).toISOString(),
      correlationId,
    }));

    await Promise.all(events.map((event) => emit(event)));

    const landed = await waitForCount(
      () => eventStore.countDomainEventsByCorrelationId(correlationId),
      100,
      45_000,
    );

    expect(landed).toBe(100);
  });
});
