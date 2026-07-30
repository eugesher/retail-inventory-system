import { FindManyOptions, FindOneOptions, LessThan, Repository } from 'typeorm';

import {
  NotificationChannelEnum,
  NotificationDeliveryStatusEnum,
} from '@retail-inventory-system/contracts';

import { IOpenNotificationDeliveryInput, NotificationDelivery } from '../../../domain';
import { NotificationDeliveryEntity } from '../notification-delivery.entity';
import { NotificationDeliveryTypeormRepository } from '../notification-delivery-typeorm.repository';

// The delivery repository had no spec, and it owns the two things the notification service is FOR:
// the dedupe collision that makes dispatch idempotent (ADR-033), and the scan the retry sweeper runs.
// Both are translation logic — a `where` clause, a branch on an error code — which is exactly the kind
// of code that fails by returning a plausible answer rather than by throwing.

const CUSTOMER_ID = '11111111-1111-4111-8111-111111111111';

const openInput = (
  overrides: Partial<IOpenNotificationDeliveryInput> = {},
): IOpenNotificationDeliveryInput => ({
  templateId: 1,
  recipientCustomerId: CUSTOMER_ID,
  recipientAddress: 'buyer@example.com',
  channel: NotificationChannelEnum.EMAIL,
  eventReferenceType: 'order',
  eventReferenceId: '42',
  renderedSubject: 'Your order is confirmed',
  renderedBody: 'Hi, thanks for your order.',
  correlationId: 'corr-1',
  ...overrides,
});

const makeEntity = (
  overrides: Partial<NotificationDeliveryEntity> = {},
): NotificationDeliveryEntity =>
  Object.assign(new NotificationDeliveryEntity(), {
    id: 7,
    templateId: 1,
    recipientCustomerId: CUSTOMER_ID,
    recipientAddress: 'buyer@example.com',
    channel: NotificationChannelEnum.EMAIL,
    eventReferenceType: 'order',
    eventReferenceId: '42',
    status: NotificationDeliveryStatusEnum.QUEUED,
    attemptCount: 0,
    lastAttemptAt: null,
    failureReason: null,
    renderedSubject: 'Your order is confirmed',
    renderedBody: 'Hi, thanks for your order.',
    correlationId: 'corr-1',
    createdAt: new Date('2026-06-27T10:00:00.000Z'),
    updatedAt: new Date('2026-06-27T10:00:00.000Z'),
    deletedAt: null,
    ...overrides,
  });

const duplicateError = (): Error =>
  Object.assign(new Error('ER_DUP_ENTRY: delivery_dedupe_key'), {
    code: 'ER_DUP_ENTRY',
    errno: 1062,
  });

// The `Repository` surface this class actually touches. Each method is a jest mock the test can
// re-program per scenario; the double is deliberately dumb — the logic under test is the repository's,
// not TypeORM's.
interface IRepoDouble {
  repository: Repository<NotificationDeliveryEntity>;
  save: jest.Mock;
  findOne: jest.Mock;
  findAndCount: jest.Mock;
  find: jest.Mock;
  query: jest.Mock;
  // The next `findOne` answer. A test must NOT reach for `findOne.mockResolvedValueOnce` instead:
  // that replaces the implementation, so the closure below never runs and the captured options stay
  // undefined — a double that silently stops recording is worse than one that never recorded.
  programFindOne: (result: NotificationDeliveryEntity | null) => void;
  lastFindOne: () => FindOneOptions<NotificationDeliveryEntity>;
  lastFind: () => FindManyOptions<NotificationDeliveryEntity>;
}

const makeRepoDouble = (): IRepoDouble => {
  let findOneOptions: FindOneOptions<NotificationDeliveryEntity> | undefined;
  let findOptions: FindManyOptions<NotificationDeliveryEntity> | undefined;
  const findOneQueue: (NotificationDeliveryEntity | null)[] = [];

  const save = jest.fn((entity: NotificationDeliveryEntity) =>
    Promise.resolve({ ...entity, id: 7 }),
  );
  const findOne = jest.fn((options: FindOneOptions<NotificationDeliveryEntity>) => {
    findOneOptions = options;
    const next = findOneQueue.length > 0 ? findOneQueue.shift()! : makeEntity();
    return Promise.resolve(next);
  });
  const findAndCount = jest.fn((options: FindManyOptions<NotificationDeliveryEntity>) => {
    findOptions = options;
    return Promise.resolve<[NotificationDeliveryEntity[], number]>([[makeEntity()], 1]);
  });
  const find = jest.fn((options: FindManyOptions<NotificationDeliveryEntity>) => {
    findOptions = options;
    return Promise.resolve([makeEntity()]);
  });
  const query = jest.fn(() => Promise.resolve({ affectedRows: 3 }));

  return {
    repository: {
      save,
      findOne,
      findAndCount,
      find,
      query,
    } as unknown as Repository<NotificationDeliveryEntity>,
    save,
    findOne,
    findAndCount,
    find,
    query,
    programFindOne: (result: NotificationDeliveryEntity | null): void => {
      findOneQueue.push(result);
    },
    lastFindOne: (): FindOneOptions<NotificationDeliveryEntity> => {
      if (findOneOptions === undefined) {
        throw new Error('findOne was never called');
      }
      return findOneOptions;
    },
    lastFind: (): FindManyOptions<NotificationDeliveryEntity> => {
      if (findOptions === undefined) {
        throw new Error('neither find nor findAndCount was called');
      }
      return findOptions;
    },
  };
};

describe('NotificationDeliveryTypeormRepository.save', () => {
  it('re-reads the committed row so the caller gets the generated id and timestamps', async () => {
    const d = makeRepoDouble();

    const saved = await new NotificationDeliveryTypeormRepository(d.repository).save(
      NotificationDelivery.open(openInput()),
    );

    expect(d.save).toHaveBeenCalledTimes(1);
    expect(saved.id).toBe(7);
    expect(saved.createdAt).toEqual(new Date('2026-06-27T10:00:00.000Z'));
  });

  it('treats a row that vanished between write and re-read as an invariant breach', async () => {
    const d = makeRepoDouble();
    d.programFindOne(null);

    await expect(
      new NotificationDeliveryTypeormRepository(d.repository).save(
        NotificationDelivery.open(openInput()),
      ),
    ).rejects.toThrow('vanished after commit');
  });

  // **The double-dispatch race (ADR-033).** Two consumers render the same notification for the same
  // event at the same instant; the loser's INSERT collides on the generated `delivery_dedupe_key`. The
  // dedupe UNIQUE is the guarantee — this branch is what turns the collision into the idempotent answer
  // rather than a 500 and a RabbitMQ redelivery loop.
  it('swallows the dedupe collision and returns the winner’s row', async () => {
    const d = makeRepoDouble();
    const winner = makeEntity({ id: 99, status: NotificationDeliveryStatusEnum.SENT });
    d.save.mockRejectedValueOnce(duplicateError());
    d.programFindOne(winner);

    const result = await new NotificationDeliveryTypeormRepository(d.repository).save(
      NotificationDelivery.open(openInput()),
    );

    // Re-read by the five dedupe COMPONENTS, not by id — the loser never learned the winner's id.
    expect(d.lastFindOne().where).toEqual({
      templateId: 1,
      eventReferenceType: 'order',
      eventReferenceId: '42',
      channel: NotificationChannelEnum.EMAIL,
      recipientCustomerId: CUSTOMER_ID,
    });
    expect(result.id).toBe(99);
    expect(result.status).toBe(NotificationDeliveryStatusEnum.SENT);
  });

  // **And it must NOT swallow one for an ops row.** `delivery_dedupe_key` is null when
  // `recipientCustomerId` is null (MySQL treats nulls as distinct in a UNIQUE), so an ops notification
  // **cannot** collide on it. A duplicate arriving here therefore is not the idempotency race — it is a
  // different constraint failing, and swallowing it would report success for a row that was never
  // written and can never be found. The `!== null` gate is what keeps that honest, and nothing checked
  // it.
  it('does NOT swallow a duplicate for an ops row (null recipient) — it cannot be the dedupe race', async () => {
    const d = makeRepoDouble();
    d.save.mockRejectedValueOnce(duplicateError());

    await expect(
      new NotificationDeliveryTypeormRepository(d.repository).save(
        NotificationDelivery.open(openInput({ recipientCustomerId: null })),
      ),
    ).rejects.toThrow('ER_DUP_ENTRY');

    // It must not even go looking: there is no dedupe scope to look in.
    expect(d.findOne).not.toHaveBeenCalled();
  });

  // A duplicate whose winner cannot be re-read is not an idempotent success. Returning anything here
  // would invent a delivery that does not exist; the error is the only honest answer.
  it('rethrows the duplicate when the winner’s row cannot be found', async () => {
    const d = makeRepoDouble();
    d.save.mockRejectedValueOnce(duplicateError());
    d.programFindOne(null);

    await expect(
      new NotificationDeliveryTypeormRepository(d.repository).save(
        NotificationDelivery.open(openInput()),
      ),
    ).rejects.toThrow('ER_DUP_ENTRY');
  });

  it('propagates an unrelated write failure untouched', async () => {
    const d = makeRepoDouble();
    d.save.mockRejectedValueOnce(
      Object.assign(new Error('connection lost'), { code: 'ECONNRESET' }),
    );

    await expect(
      new NotificationDeliveryTypeormRepository(d.repository).save(
        NotificationDelivery.open(openInput()),
      ),
    ).rejects.toThrow('connection lost');
  });
});

describe('NotificationDeliveryTypeormRepository.findById', () => {
  // A miss must be `null`, not a rejection: every caller above this — Record Outcome, manual
  // Retry — turns the null into a typed `DELIVERY_NOT_FOUND` (404). A repository that threw
  // instead would surface an unknown id as a 500.
  it('resolves a missing row to null rather than throwing', async () => {
    const d = makeRepoDouble();
    d.programFindOne(null);

    const found = await new NotificationDeliveryTypeormRepository(d.repository).findById(404);

    expect(found).toBeNull();
    expect(d.lastFindOne().where).toEqual({ id: 404 });
  });

  it('maps a found row to the domain aggregate', async () => {
    const d = makeRepoDouble();

    const found = await new NotificationDeliveryTypeormRepository(d.repository).findById(7);

    expect(found).toBeInstanceOf(NotificationDelivery);
    expect(found?.id).toBe(7);
  });
});

describe('NotificationDeliveryTypeormRepository.list', () => {
  it('builds an empty where-clause when no filter is supplied', async () => {
    const d = makeRepoDouble();

    await new NotificationDeliveryTypeormRepository(d.repository).list({}, { page: 1, size: 20 });

    expect(d.lastFind().where).toEqual({});
  });

  // All five filters at once. `channel` and `recipientCustomerId` were the two nothing exercised — and
  // a filter that silently drops is invisible: the caller gets a well-formed page of the WRONG rows.
  it('maps each filter onto one equality predicate', async () => {
    const d = makeRepoDouble();

    await new NotificationDeliveryTypeormRepository(d.repository).list(
      {
        status: NotificationDeliveryStatusEnum.FAILED,
        channel: NotificationChannelEnum.EMAIL,
        eventReferenceType: 'order',
        eventReferenceId: '42',
        recipientCustomerId: CUSTOMER_ID,
      },
      { page: 1, size: 20 },
    );

    expect(d.lastFind().where).toEqual({
      status: NotificationDeliveryStatusEnum.FAILED,
      channel: NotificationChannelEnum.EMAIL,
      eventReferenceType: 'order',
      eventReferenceId: '42',
      recipientCustomerId: CUSTOMER_ID,
    });
  });

  it('orders newest-first with an id tiebreaker and translates the 1-based page', async () => {
    const d = makeRepoDouble();

    await new NotificationDeliveryTypeormRepository(d.repository).list({}, { page: 3, size: 25 });

    expect(d.lastFind().order).toEqual({ createdAt: 'DESC', id: 'DESC' });
    expect(d.lastFind().skip).toBe(50);
    expect(d.lastFind().take).toBe(25);
  });

  it('maps the rows to domain deliveries and echoes the envelope', async () => {
    const d = makeRepoDouble();

    const page = await new NotificationDeliveryTypeormRepository(d.repository).list(
      {},
      { page: 2, size: 10 },
    );

    expect(page.items[0]).toBeInstanceOf(NotificationDelivery);
    expect(page.total).toBe(1);
    expect(page.page).toBe(2);
    expect(page.size).toBe(10);
  });
});

describe('NotificationDeliveryTypeormRepository.listRetryable', () => {
  // The sweeper's scan. `attemptCount < maxAttempts` is the budget — an off-by-one here (`LessThan` →
  // `LessThanOrEqual`) does not fail: it just retries every delivery one extra time, forever, against a
  // transport that already refused it.
  const STALE_BEFORE = new Date('2026-07-24T11:55:00.000Z');

  it('scans failed rows under the attempt budget, oldest attempt first, bounded by the limit', async () => {
    const d = makeRepoDouble();

    const rows = await new NotificationDeliveryTypeormRepository(d.repository).listRetryable(
      3,
      50,
      STALE_BEFORE,
    );

    // An ARRAY of where-objects is TypeORM's OR. The FIRST arm is the ordinary one.
    expect((d.lastFind().where as unknown[])[0]).toEqual({
      status: NotificationDeliveryStatusEnum.FAILED,
      attemptCount: LessThan(3),
    });
    expect(d.lastFind().order).toEqual({ lastAttemptAt: 'ASC', id: 'ASC' });
    expect(d.lastFind().take).toBe(50);
    expect(rows[0]).toBeInstanceOf(NotificationDelivery);
  });

  // The second arm. Without it a delivery orphaned in `queued` between the persist and the dispatch
  // is unreachable by every path in the service — the sweeper never sees it and the manual retry
  // refuses it — which is precisely what ADR-033 §3 says must not happen.
  it('also scans queued rows older than the staleness horizon — the orphan arm', async () => {
    const d = makeRepoDouble();

    await new NotificationDeliveryTypeormRepository(d.repository).listRetryable(
      3,
      50,
      STALE_BEFORE,
    );

    expect((d.lastFind().where as unknown[])[1]).toEqual({
      status: NotificationDeliveryStatusEnum.QUEUED,
      createdAt: LessThan(STALE_BEFORE),
    });
  });

  // The bound is the whole point of the orphan arm: a `queued` row persisted moments ago is being
  // dispatched RIGHT NOW, and re-dispatching it is a race, not a recovery. An unbounded
  // `status = queued` arm would double-send every notification in flight on every sweep.
  it('bounds the queued arm by created_at — never an unqualified status scan', async () => {
    const d = makeRepoDouble();

    await new NotificationDeliveryTypeormRepository(d.repository).listRetryable(
      3,
      50,
      STALE_BEFORE,
    );

    const queuedArm = (d.lastFind().where as Record<string, unknown>[])[1];
    expect(Object.keys(queuedArm).sort()).toEqual(['createdAt', 'status']);
  });

  // `find`, never `findAndCount`: the sweeper iterates the batch and would discard a `COUNT(*)` it
  // paid a full table scan for.
  it('does not pay for a COUNT it would discard', async () => {
    const d = makeRepoDouble();

    await new NotificationDeliveryTypeormRepository(d.repository).listRetryable(
      3,
      50,
      STALE_BEFORE,
    );

    expect(d.find).toHaveBeenCalledTimes(1);
    expect(d.findAndCount).not.toHaveBeenCalled();
  });
});

describe('NotificationDeliveryTypeormRepository.deleteOlderThan', () => {
  // The bound is the entire point (ISSUE-08): `DeleteQueryBuilder` has no `.limit()` and
  // `repository.delete()` takes no bound, so an ORM-shaped version of this would be an UNBOUNDED
  // `DELETE` on the busiest table in the schema. Pin the `LIMIT`, and pin that the horizon column is
  // `created_at` — retention is about how old the RECORD is, not when it was last touched.
  it('issues a bounded DELETE against created_at, parameterized', async () => {
    const d = makeRepoDouble();
    const horizon = new Date('2026-04-01T00:00:00.000Z');

    const deleted = await new NotificationDeliveryTypeormRepository(d.repository).deleteOlderThan(
      horizon,
      500,
    );

    expect(d.query).toHaveBeenCalledWith(
      'DELETE FROM notification_delivery WHERE created_at < ? LIMIT ?;',
      [horizon, 500],
    );
    expect(deleted).toBe(3);
  });

  // `mysql2` answers a DELETE with an `OkPacket`, and `Repository.query` is typed `Promise<any>` — so
  // the shape is asserted, not known. A driver that answered with anything else must yield 0, not
  // `undefined`: the use case logs the count and the scheduler reads it.
  it('reports 0 rather than undefined when the driver answers with no affectedRows', async () => {
    const d = makeRepoDouble();
    d.query.mockResolvedValueOnce({});

    await expect(
      new NotificationDeliveryTypeormRepository(d.repository).deleteOlderThan(new Date(), 500),
    ).resolves.toBe(0);
  });
});
