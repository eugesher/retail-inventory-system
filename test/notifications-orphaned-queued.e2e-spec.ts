import { INestMicroservice } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { MicroserviceOptions, Transport } from '@nestjs/microservices';

import { AppModule as NotificationMicroserviceAppModule } from '@retail-inventory-system/apps/notification-microservice';
import { MicroserviceQueueEnum } from '@retail-inventory-system/contracts';

import {
  QUEUED_STALE_AFTER_MS,
  RetryDeliveryUseCase,
  RetryFailedDeliveriesUseCase,
} from '../apps/notification-microservice/src/modules/notifications/application/use-cases';
import { OrphanedQueuedE2ESpecDataSource } from './data-source/orphaned-queued.e2e-spec.data-source';

// The orphaned-`queued` rescue — **the row ADR-033 promised the sweeper would pick up, and it did
// not.**
//
// The Render & Dispatch pipeline is persist-then-send: the delivery row commits `queued`, the
// `NOTIFIER` is called, and only then is the row flipped `sent`/`failed`. ADR-033 §3 chose that
// order on an explicit promise — *"a crash mid-send then still leaves an auditable row **the retry
// sweeper can pick up**"* — trading a possible duplicate for never losing the audit trail.
//
// The sweeper did not pick it up. `listRetryable` scanned `status = 'failed'` alone, and the manual
// retry RPC refused anything that was not `failed` with a 409. So a row stranded in `queued` was
// unreachable by **every** path in the service, automatic and human alike: the notification may
// never have been sent, and the trail said `queued` forever. The system took the cost of
// persist-then-send without ever collecting its benefit.
//
// A crash is not even the likeliest way in. If the pipeline's SECOND `save` throws, the exception
// escapes the `@EventPattern` consumer and RabbitMQ redelivers the event — but the redelivery hits
// the dedupe pre-check, finds the `queued` row, and returns it WITHOUT dispatching. The one path
// that looks like a second chance is the path that closes the door.
//
// This suite seeds the stuck row directly, because the application cannot be asked to produce one:
// the pipeline writes `queued` and flips it inside a single call. It then drives the REAL use cases
// resolved out of the running notification service, and asserts against the TABLE — the rescue's
// whole point is that the row's status changes, and a spec that trusted a return value would not
// notice a save that never landed.
const MINUTE_MS = 60_000;

describe('Notification delivery orphaned in queued (e2e)', () => {
  const timeout = 60_000;

  let notificationMicroservice: INestMicroservice;
  let dataSource: OrphanedQueuedE2ESpecDataSource;
  let sweeper: RetryFailedDeliveriesUseCase;
  let manualRetry: RetryDeliveryUseCase;

  const stamp = Date.now();
  const realNow = new Date();

  let templateId: number;
  let orphanId: number;
  let freshId: number;
  // Seeded inside the operator test rather than in `beforeAll`, and that is not tidiness: the
  // sweep in the first test scans EVERY orphan past the horizon, so a row parked here in advance
  // would already be `sent` by the time the operator path ran. There is no way to hide a row from
  // the sweeper, and there should not be.
  let manualOrphanId: number | undefined;

  beforeAll(async () => {
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

    sweeper = notificationMicroservice.get(RetryFailedDeliveriesUseCase, { strict: false });
    manualRetry = notificationMicroservice.get(RetryDeliveryUseCase, { strict: false });

    // **`timezone: 'Z'` is load-bearing here, not boilerplate.** `DatabaseModule.forRoot` pins the
    // application's connection to UTC; a seeding connection that does not falls back to the Node
    // host's local zone, so `mysql2` stores the local wall-clock rendering of the `Date` it is
    // handed. On a UTC+7 host a row seeded "fifteen minutes ago" lands in the table as nearly
    // seven hours in the FUTURE once the app reads it back as UTC — and a staleness rule measured
    // in minutes reads that as "brand new", which is exactly the answer that hides the bug.
    //
    // The sibling `delivery-retention-purge` spec omits this and passes anyway: its offset is a
    // hundred days, so a few hours of skew disappears into the margin. A five-minute horizon has no
    // margin to hide in.
    dataSource = new OrphanedQueuedE2ESpecDataSource({
      type: 'mysql',
      url: process.env.DATABASE_URL!,
      timezone: 'Z',
    });
    await dataSource.initialize();

    templateId = await dataSource.anyTemplateId();

    // ORPHANED: `queued`, created well past the staleness horizon. This is the row the sweep must
    // rescue.
    orphanId = await dataSource.seedOrphanedQueued(
      templateId,
      `orphan-swept-${stamp}`,
      new Date(realNow.getTime() - (QUEUED_STALE_AFTER_MS + 10 * MINUTE_MS)),
    );
    // FRESH: `queued`, created just now — a delivery plausibly being dispatched at this instant.
    // It must survive every sweep in this file untouched.
    freshId = await dataSource.seedOrphanedQueued(templateId, `orphan-fresh-${stamp}`, realNow);
  }, timeout);

  afterAll(async () => {
    // The rows carry a NULL dedupe key, so they collide with nothing — but a suite that leaves
    // `queued` rows behind hands the next run's sweeper work that is not its own.
    await dataSource?.deleteDelivery(orphanId);
    await dataSource?.deleteDelivery(freshId);
    if (manualOrphanId !== undefined) {
      await dataSource.deleteDelivery(manualOrphanId);
    }
    await notificationMicroservice?.close();
    await dataSource?.destroy();
  });

  it(
    'the scheduled sweep rescues the orphan and leaves the fresh queued row alone',
    async () => {
      expect((await dataSource.statusOf(orphanId))?.status).toBe('queued');
      expect((await dataSource.statusOf(freshId))?.status).toBe('queued');

      await sweeper.execute();

      // The orphan was re-dispatched through the real `LogNotifierAdapter`, so it lands `sent`
      // with attempt_count 1 — its FIRST recorded attempt, not a second one. Nothing was ever
      // attempted against it before; that is what made it invisible.
      const rescued = await dataSource.statusOf(orphanId);
      expect(rescued?.status).toBe('sent');
      expect(rescued?.attemptCount).toBe(1);

      // The bound earning its keep. Without `created_at < queuedStaleBefore` in the scan, this row
      // — which may be inside a live dispatch right now — would be re-sent on every sweep.
      const untouched = await dataSource.statusOf(freshId);
      expect(untouched?.status).toBe('queued');
      expect(untouched?.attemptCount).toBe(0);
    },
    timeout,
  );

  it(
    'the operator manual retry also accepts an orphan, and still refuses a fresh queued row',
    async () => {
      // Seeded here, after the sweep above has already run and taken every orphan it could see.
      manualOrphanId = await dataSource.seedOrphanedQueued(
        templateId,
        `orphan-manual-${stamp}`,
        new Date(Date.now() - (QUEUED_STALE_AFTER_MS + 10 * MINUTE_MS)),
      );

      const view = await manualRetry.execute({
        deliveryId: manualOrphanId,
        correlationId: `corr-manual-orphan-${stamp}`,
      });
      expect(view.status).toBe('sent');
      expect(view.attemptCount).toBe(1);

      // The other half of the same rule: age, not merely status. A fresh `queued` row is still a
      // 409, so an operator cannot race a dispatch that is in flight.
      await expect(
        manualRetry.execute({ deliveryId: freshId, correlationId: `corr-manual-fresh-${stamp}` }),
      ).rejects.toMatchObject({ code: 'NOTIFICATION_DELIVERY_INVALID_STATUS_TRANSITION' });
      expect((await dataSource.statusOf(freshId))?.status).toBe('queued');
    },
    timeout,
  );

  it(
    'a rescued row is an ordinary delivery afterwards — a second sweep does not touch it',
    async () => {
      // It is `sent` now, so neither arm of the scan matches it. A rescue that left the row in
      // some in-between state the sweeper kept re-selecting would show up here as a second attempt.
      await sweeper.execute();

      const after = await dataSource.statusOf(orphanId);
      expect(after?.status).toBe('sent');
      expect(after?.attemptCount).toBe(1);
    },
    timeout,
  );
});
