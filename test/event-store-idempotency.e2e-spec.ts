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

// Proves the firehose ingest's two crash-/redelivery-safety guarantees directly against
// the topic exchange (ADR-035 + the at-least-once stance, ADR-020), bypassing the
// producers so the wire payload is fully controlled:
//
//  1. Idempotency — the same wire event published twice yields EXACTLY ONE row. The
//     composite UNIQUE `(producer, event_type, aggregate_id, occurred_at, correlation_id)`
//     collapses the redelivery; the second `append` is a no-op.
//  2. No-loss under fan-out — 100 DISTINCT events published concurrently all land
//     (count = 100), so nothing is dropped when the consumer is hit by a burst.
//
// The suite boots only the event store (the consumer + ingest) and emits onto
// `ris.events` through a test `ClientProxy` shaped exactly like the producers' shared
// `RIS_EVENTS_PUBLISHER` client (named topic exchange, `wildcards: true`). Reads are by
// direct SQL because the subject is the INGEST's dedupe rule — the composite UNIQUE — and
// counting rows through `GET /api/audit/events` would make a write-path assertion depend
// on the read path. It also keeps the suite free of the gateway and its query transport.
// Ingestion is async, so both cases poll up to a bounded timeout.
const EVENT_TYPE = 'retail.order.placed';
const PRODUCER = 'retail-microservice'; // resolveProducer('retail.…')

interface ICraftedEvent {
  orderId: number;
  eventVersion: 'v1';
  occurredAt: string;
  correlationId: string;
}

// The MySQL TIMESTAMP(3) wall-clock literal for an ISO instant. The ingest stores
// `new Date(payload.occurredAt)`; the data source reads/writes under `timezone: 'Z'`, so
// the UTC wall-clock round-trips and this literal matches the stored value for the
// composite-key lookup.
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

    // The producer-side client for the `ris.events` topic exchange: with a named
    // exchange + `wildcards: true`, `emit(routingKey, payload)` uses `routingKey` as the
    // AMQP topic key — the exact shape `MicroserviceClientRisEventsModule` registers.
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

    // Publish the identical wire event twice — the at-least-once redelivery a real
    // broker would do under a consumer crash/ack-loss.
    await emit(event);
    await emit(event);

    // Wait until at least one row has been ingested, then assert no second row appeared.
    const landed = await waitForCount(
      () => eventStore.countDomainEventsByCorrelationId(correlationId),
      1,
      30_000,
    );
    expect(landed).toBe(1);

    // Settle a beat so a (would-be) second insert has every chance to race in, then
    // re-assert via the composite UNIQUE key directly.
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

    // 100 DISTINCT events — distinct aggregate id AND distinct occurred_at, so each is a
    // unique composite key (none are deduped against each other). Shared correlation id
    // scopes the count to this burst alone.
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

    // Exactly 100: no event dropped (would be < 100), and at-least-once redelivery did
    // not inflate the log (the composite UNIQUE would collapse any duplicate).
    expect(landed).toBe(100);
  });
});
