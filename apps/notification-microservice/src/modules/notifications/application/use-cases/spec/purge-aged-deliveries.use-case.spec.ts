import { PinoLogger } from 'nestjs-pino';

import {
  NotificationChannelEnum,
  NotificationDeliveryStatusEnum,
} from '@retail-inventory-system/contracts';

import { NotificationDelivery } from '../../../domain';
import { PurgeAgedDeliveriesUseCase } from '../purge-aged-deliveries.use-case';
import { FakeLogger, InMemoryDeliveryRepo } from './test-doubles';

const RETENTION_DAYS = 90;
// A pinned `now`. **The whole point of the `now` parameter** — a retention sweep that reads the wall
// clock cannot be tested without either sleeping or lying about the system time, and both are how a
// purge spec ends up asserting nothing.
const NOW = new Date('2026-07-13T03:00:00Z');

const daysBefore = (days: number): Date => new Date(NOW.getTime() - days * 86_400_000);

// A delivery already persisted at a chosen `createdAt` — the row's age is the only thing the sweep
// looks at, so the spec has to be able to set it.
const agedDelivery = (id: number, createdAt: Date): NotificationDelivery =>
  NotificationDelivery.reconstitute({
    id,
    templateId: 1,
    recipientCustomerId: `cust-${id}`,
    recipientAddress: `ada${id}@example.com`,
    channel: NotificationChannelEnum.EMAIL,
    eventReferenceType: 'order',
    eventReferenceId: String(id),
    status: NotificationDeliveryStatusEnum.SENT,
    attemptCount: 1,
    lastAttemptAt: createdAt,
    failureReason: null,
    renderedSubject: 'Order confirmed',
    renderedBody: 'Your order is on its way',
    correlationId: `corr-${id}`,
    createdAt,
  });

describe('PurgeAgedDeliveriesUseCase', () => {
  let repo: InMemoryDeliveryRepo;
  let logger: FakeLogger;
  let useCase: PurgeAgedDeliveriesUseCase;

  beforeEach(() => {
    repo = new InMemoryDeliveryRepo();
    logger = new FakeLogger();
    useCase = new PurgeAgedDeliveriesUseCase(repo, RETENTION_DAYS, logger as unknown as PinoLogger);
  });

  it('purges nothing when every row is inside the horizon', async () => {
    await repo.save(agedDelivery(1, daysBefore(1)));
    await repo.save(agedDelivery(2, daysBefore(89)));

    await expect(useCase.execute(NOW)).resolves.toBe(0);
    expect(repo.rows).toHaveLength(2);
  });

  // **The assertion the config key has been promising since the beginning.** `RETENTION_DELIVERY_DAYS`
  // sat in the shared Joi schema, `.default(90)`, validated at boot by every service — and nothing
  // read it. An operator who set it got silence.
  it('purges a row older than the horizon and leaves one inside it', async () => {
    const aged = await repo.save(agedDelivery(1, daysBefore(91)));
    const fresh = await repo.save(agedDelivery(2, daysBefore(89)));

    await expect(useCase.execute(NOW)).resolves.toBe(1);

    expect(repo.rows.map((r) => r.id)).toEqual([fresh.id]);
    expect(repo.rows.map((r) => r.id)).not.toContain(aged.id);
  });

  // The boundary is `created_at < horizon`, so a row exactly ON the horizon survives. Pinned because
  // an off-by-one here silently deletes a day's worth of rows early, and nothing would ever say so.
  it('keeps a row that is exactly on the horizon', async () => {
    await repo.save(agedDelivery(1, daysBefore(RETENTION_DAYS)));

    await expect(useCase.execute(NOW)).resolves.toBe(0);
    expect(repo.rows).toHaveLength(1);
  });

  it('honours the configured horizon rather than a hardcoded one', async () => {
    const sevenDay = new PurgeAgedDeliveriesUseCase(repo, 7, logger as unknown as PinoLogger);
    await repo.save(agedDelivery(1, daysBefore(10)));

    // The same row that survives a 90-day horizon is aged out by a 7-day one. **This is the test that
    // could not have been written before** — there was no token to inject, because there was no
    // reader.
    await expect(sevenDay.execute(NOW)).resolves.toBe(1);
    expect(repo.rows).toHaveLength(0);
  });

  it('logs the sweep with the horizon it used', async () => {
    await repo.save(agedDelivery(1, daysBefore(120)));

    await useCase.execute(NOW);

    const line = logger.logs.at(-1);
    expect(line?.context).toMatchObject({
      deleted: 1,
      retentionDays: RETENTION_DAYS,
      // The horizon is DERIVED from the injected days and the passed `now` — a log line that reported
      // a horizon the sweep did not use would make every future incident report wrong.
      horizon: daysBefore(RETENTION_DAYS).toISOString(),
    });
  });
});
