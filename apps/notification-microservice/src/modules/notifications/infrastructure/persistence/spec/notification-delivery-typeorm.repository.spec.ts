import { FindManyOptions, FindOneOptions, LessThan, Repository } from 'typeorm';

import {
  NotificationChannelEnum,
  NotificationDeliveryStatusEnum,
} from '@retail-inventory-system/contracts';

import { IOpenNotificationDeliveryInput, NotificationDelivery } from '../../../domain';
import { NotificationDeliveryEntity } from '../notification-delivery.entity';
import { NotificationDeliveryTypeormRepository } from '../notification-delivery-typeorm.repository';

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

interface IRepoDouble {
  repository: Repository<NotificationDeliveryEntity>;
  save: jest.Mock;
  findOne: jest.Mock;
  findAndCount: jest.Mock;
  find: jest.Mock;
  query: jest.Mock;
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

  it('swallows the dedupe collision and returns the winner’s row', async () => {
    const d = makeRepoDouble();
    const winner = makeEntity({ id: 99, status: NotificationDeliveryStatusEnum.SENT });
    d.save.mockRejectedValueOnce(duplicateError());
    d.programFindOne(winner);

    const result = await new NotificationDeliveryTypeormRepository(d.repository).save(
      NotificationDelivery.open(openInput()),
    );

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

  it('does NOT swallow a duplicate for an ops row (null recipient) — it cannot be the dedupe race', async () => {
    const d = makeRepoDouble();
    d.save.mockRejectedValueOnce(duplicateError());

    await expect(
      new NotificationDeliveryTypeormRepository(d.repository).save(
        NotificationDelivery.open(openInput({ recipientCustomerId: null })),
      ),
    ).rejects.toThrow('ER_DUP_ENTRY');

    expect(d.findOne).not.toHaveBeenCalled();
  });

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
  const STALE_BEFORE = new Date('2026-07-24T11:55:00.000Z');

  it('scans failed rows under the attempt budget, oldest attempt first, bounded by the limit', async () => {
    const d = makeRepoDouble();

    const rows = await new NotificationDeliveryTypeormRepository(d.repository).listRetryable(
      3,
      50,
      STALE_BEFORE,
    );

    expect((d.lastFind().where as unknown[])[0]).toEqual({
      status: NotificationDeliveryStatusEnum.FAILED,
      attemptCount: LessThan(3),
    });
    expect(d.lastFind().order).toEqual({ lastAttemptAt: 'ASC', id: 'ASC' });
    expect(d.lastFind().take).toBe(50);
    expect(rows[0]).toBeInstanceOf(NotificationDelivery);
  });

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

  it('reports 0 rather than undefined when the driver answers with no affectedRows', async () => {
    const d = makeRepoDouble();
    d.query.mockResolvedValueOnce({});

    await expect(
      new NotificationDeliveryTypeormRepository(d.repository).deleteOlderThan(new Date(), 500),
    ).resolves.toBe(0);
  });
});
