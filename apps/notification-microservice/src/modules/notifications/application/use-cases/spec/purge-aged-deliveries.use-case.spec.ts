import { PinoLogger } from 'nestjs-pino';

import {
  NotificationChannelEnum,
  NotificationDeliveryStatusEnum,
} from '@retail-inventory-system/contracts';

import { NotificationDelivery } from '../../../domain';
import { PurgeAgedDeliveriesUseCase } from '../purge-aged-deliveries.use-case';
import { FakeLogger, InMemoryDeliveryRepo } from './test-doubles';

const RETENTION_DAYS = 90;
const NOW = new Date('2026-07-13T03:00:00Z');

const daysBefore = (days: number): Date => new Date(NOW.getTime() - days * 86_400_000);

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

  it('purges a row older than the horizon and leaves one inside it', async () => {
    const aged = await repo.save(agedDelivery(1, daysBefore(91)));
    const fresh = await repo.save(agedDelivery(2, daysBefore(89)));

    await expect(useCase.execute(NOW)).resolves.toBe(1);

    expect(repo.rows.map((r) => r.id)).toEqual([fresh.id]);
    expect(repo.rows.map((r) => r.id)).not.toContain(aged.id);
  });

  it('keeps a row that is exactly on the horizon', async () => {
    await repo.save(agedDelivery(1, daysBefore(RETENTION_DAYS)));

    await expect(useCase.execute(NOW)).resolves.toBe(0);
    expect(repo.rows).toHaveLength(1);
  });

  it('honours the configured horizon rather than a hardcoded one', async () => {
    const sevenDay = new PurgeAgedDeliveriesUseCase(repo, 7, logger as unknown as PinoLogger);
    await repo.save(agedDelivery(1, daysBefore(10)));

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
      horizon: daysBefore(RETENTION_DAYS).toISOString(),
    });
  });
});
