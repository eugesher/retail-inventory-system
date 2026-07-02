import { INestMicroservice } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { MicroserviceOptions, Transport } from '@nestjs/microservices';

import { AppModule as RetailMicroserviceAppModule } from '@retail-inventory-system/apps/retail-microservice';
import { MicroserviceQueueEnum } from '@retail-inventory-system/contracts';

import { PurgeExpiredIdempotencyKeysUseCase } from '../apps/retail-microservice/src/modules/orders/application/use-cases/purge-expired-idempotency-keys.use-case';
import { IdempotencyE2ESpecDataSource } from './data-source/idempotency.e2e-spec.data-source';

// The TTL purge sweep over the `idempotency_key` store (ADR-036). The store is
// live-ephemeral: `find` never filters by expiry, so a scheduled sweep is the SOLE
// authority that removes a row once its `expires_at` horizon has passed. This suite
// proves the sweep end-to-end by resolving the real `PurgeExpiredIdempotencyKeysUseCase`
// from the running retail microservice and driving it through its explicit-`now` testing
// seam — `execute(now)` takes the instant to compare `expires_at` against, so the suite
// can "leave a row, advance simulated time, observe deletion" without touching the system
// clock or waiting out a real 24h TTL.
//
// Two rows are seeded straight into the table: an AGED row (expires just after real `now`)
// and a CONTROL row (expires far in the future). A purge at real `now` deletes neither
// (both still fresh); a purge at a FUTURE `now` past the aged row's horizon deletes exactly
// the aged row and leaves the control — the strict `expires_at < now` predicate, asserted
// by direct SQL against the row.
const PURGE_SCOPE = 'e2e-purge';
const HOUR_MS = 3_600_000;

describe('Idempotency key TTL purge sweep (e2e)', () => {
  const timeout = 60_000;

  let retailMicroservice: INestMicroservice;
  let dataSource: IdempotencyE2ESpecDataSource;
  let purge: PurgeExpiredIdempotencyKeysUseCase;

  const stamp = Date.now();
  const agedKey = `aged-${stamp}`;
  const controlKey = `control-${stamp}`;

  beforeAll(async () => {
    const rmqUrl = process.env.RABBITMQ_URL!;

    retailMicroservice = await NestFactory.createMicroservice<MicroserviceOptions>(
      RetailMicroserviceAppModule,
      {
        logger: false,
        transport: Transport.RMQ,
        options: {
          urls: [rmqUrl],
          queue: MicroserviceQueueEnum.RETAIL_QUEUE,
          queueOptions: { durable: true },
        },
      },
    );
    await retailMicroservice.listen();

    // Pin the seeding connection to UTC (`timezone: 'Z'`), matching the app's
    // `DatabaseModule`, so the `expires_at` this suite writes and the `now` the purge
    // compares it against are the same wall-clock — otherwise a double timezone shift
    // would move the aged row's horizon and the sweep would miss it.
    dataSource = new IdempotencyE2ESpecDataSource({
      type: 'mysql',
      url: process.env.DATABASE_URL!,
      timezone: 'Z',
    });
    await dataSource.initialize();

    // The real application-layer purge use case, resolved from the running service graph
    // (`strict: false` so it is found inside the orders module, not just the root).
    purge = retailMicroservice.get(PurgeExpiredIdempotencyKeysUseCase, { strict: false });

    // Start each run from a known-empty scope so the fixtures never collide with a prior run.
    await dataSource.deleteIdempotencyKeysByScope(PURGE_SCOPE);
  }, timeout);

  afterAll(async () => {
    await dataSource?.deleteIdempotencyKeysByScope(PURGE_SCOPE);
    await retailMicroservice?.close();
    await dataSource?.destroy();
  });

  it('a purge at the current instant deletes neither a just-future nor a far-future row', async () => {
    // Aged: expires 1 minute after real `now` (fresh now, expired at the future `now` below).
    await dataSource.insertIdempotencyKey({
      scope: PURGE_SCOPE,
      key: agedKey,
      expiresAt: new Date(Date.now() + 60_000),
    });
    // Control: expires 48 hours out — well beyond even the future `now` used later.
    await dataSource.insertIdempotencyKey({
      scope: PURGE_SCOPE,
      key: controlKey,
      expiresAt: new Date(Date.now() + 48 * HOUR_MS),
    });

    expect(await dataSource.countIdempotencyKeysByScope(PURGE_SCOPE)).toBe(2);

    // A sweep at the real clock: neither of MY rows has expired yet, so both survive. The
    // returned count is table-wide (other suites' rows may also be swept), so the proof is
    // the row-level survival of both fixtures, not the number.
    await purge.execute(new Date());

    expect(await dataSource.getIdempotencyKey(PURGE_SCOPE, agedKey)).toBeDefined();
    expect(await dataSource.getIdempotencyKey(PURGE_SCOPE, controlKey)).toBeDefined();
  });

  it('a purge at a future instant deletes exactly the aged row and keeps the control', async () => {
    // Advance simulated time one hour: past the aged row's 1-minute horizon, still well
    // short of the control's 48-hour horizon.
    const futureNow = new Date(Date.now() + HOUR_MS);

    const deleted = await purge.execute(futureNow);

    // At least the aged row was reclaimed (the count is table-wide, so `>= 1`).
    expect(deleted).toBeGreaterThanOrEqual(1);
    // The aged row is gone; the not-yet-expired control row survives — the strict
    // `expires_at < now` predicate.
    expect(await dataSource.getIdempotencyKey(PURGE_SCOPE, agedKey)).toBeUndefined();
    expect(await dataSource.getIdempotencyKey(PURGE_SCOPE, controlKey)).toBeDefined();
    expect(await dataSource.countIdempotencyKeysByScope(PURGE_SCOPE)).toBe(1);
  });
});
