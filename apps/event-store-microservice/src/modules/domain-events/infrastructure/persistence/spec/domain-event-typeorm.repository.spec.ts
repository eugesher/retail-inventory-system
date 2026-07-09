import { Between, FindManyOptions, LessThanOrEqual, MoreThanOrEqual, Repository } from 'typeorm';

import { DomainEvent } from '../../../domain';
import { DomainEventEntity } from '../domain-event.entity';
import { DomainEventTypeormRepository } from '../domain-event-typeorm.repository';

// A minimal TypeORM `Repository` double — only the methods the repository touches
// (`insert` for append). The test proves the idempotency contract WITHOUT a database:
// the composite-UNIQUE `ER_DUP_ENTRY` is swallowed as `{ inserted: false }`, a clean
// insert reports `{ inserted: true }`, and an unrelated failure still propagates. The
// full end-to-end idempotency proof is the firehose-ingestion suite + e2e (later
// capabilities); this locks the repository's swallow in isolation.
// Returns the repository double alongside the `insert` mock, so assertions hold a
// reference to the jest function rather than reaching back through the repository
// object (which the unbound-method lint rule forbids).
const makeRepositoryDouble = (
  insertImpl: () => Promise<unknown>,
): { repository: Repository<DomainEventEntity>; insert: jest.Mock } => {
  const insert = jest.fn(insertImpl);
  return {
    repository: { insert } as unknown as Repository<DomainEventEntity>,
    insert,
  };
};

const makeEvent = (): DomainEvent =>
  DomainEvent.create({
    eventType: 'retail.order.placed',
    aggregateType: 'order',
    aggregateId: '42',
    payload: { orderId: 42 },
    eventVersion: 'v1',
    producer: 'retail-microservice',
    correlationId: 'corr-1',
    occurredAt: new Date('2026-06-27T10:00:00.000Z'),
  });

describe('DomainEventTypeormRepository.append', () => {
  it('reports { inserted: true } on a clean insert', async () => {
    const { repository: repoDouble, insert } = makeRepositoryDouble(() =>
      Promise.resolve({ identifiers: [{ id: 1 }] }),
    );
    const repository = new DomainEventTypeormRepository(repoDouble);

    await expect(repository.append(makeEvent())).resolves.toEqual({ inserted: true });
    expect(insert).toHaveBeenCalledTimes(1);
  });

  it('swallows the composite-UNIQUE ER_DUP_ENTRY as { inserted: false } without throwing', async () => {
    // The shape the mysql2 driver surfaces on a UNIQUE collision (a RabbitMQ redelivery
    // of an already-captured event).
    const dupError = Object.assign(new Error('duplicate'), {
      code: 'ER_DUP_ENTRY',
      errno: 1062,
    });
    const { repository: repoDouble } = makeRepositoryDouble(() => Promise.reject(dupError));
    const repository = new DomainEventTypeormRepository(repoDouble);

    await expect(repository.append(makeEvent())).resolves.toEqual({ inserted: false });
  });

  it('swallows a duplicate nested under driverError too', async () => {
    const dupError = Object.assign(new Error('duplicate'), {
      driverError: { code: 'ER_DUP_ENTRY', errno: 1062 },
    });
    const { repository: repoDouble } = makeRepositoryDouble(() => Promise.reject(dupError));
    const repository = new DomainEventTypeormRepository(repoDouble);

    await expect(repository.append(makeEvent())).resolves.toEqual({ inserted: false });
  });

  it('propagates an unrelated insert failure (only duplicates are swallowed)', async () => {
    const otherError = Object.assign(new Error('connection lost'), { code: 'ECONNRESET' });
    const { repository: repoDouble } = makeRepositoryDouble(() => Promise.reject(otherError));
    const repository = new DomainEventTypeormRepository(repoDouble);

    await expect(repository.append(makeEvent())).rejects.toThrow('connection lost');
  });
});

// A `findAndCount` double that CAPTURES the `FindManyOptions` the repository built, and hands
// it back through a typed accessor rather than through `mock.calls` (which is `any`-typed and
// would need an assertion the no-unsafe-* rules forbid). The tests assert the WHERE / ORDER BY
// / SKIP / TAKE the repository derives from the wire filters, without a database — that
// translation layer is the whole risk here, not MySQL's ability to execute the query.
interface IQueryDouble {
  repository: Repository<DomainEventEntity>;
  options: () => FindManyOptions<DomainEventEntity>;
}

const makeQueryDouble = (rows: DomainEventEntity[] = [], total = 0): IQueryDouble => {
  let captured: FindManyOptions<DomainEventEntity> | undefined;
  const findAndCount = jest.fn((options: FindManyOptions<DomainEventEntity>) => {
    captured = options;
    return Promise.resolve<[DomainEventEntity[], number]>([rows, total]);
  });

  return {
    repository: { findAndCount } as unknown as Repository<DomainEventEntity>,
    options: (): FindManyOptions<DomainEventEntity> => {
      if (captured === undefined) {
        throw new Error('findAndCount was never called');
      }
      return captured;
    },
  };
};

const makeEntity = (): DomainEventEntity =>
  Object.assign(new DomainEventEntity(), {
    id: 7,
    eventType: 'retail.order.placed',
    aggregateType: 'order',
    aggregateId: '42',
    payload: { orderId: 42 },
    eventVersion: 'v1',
    producer: 'retail',
    correlationId: 'corr-1',
    occurredAt: new Date('2026-06-27T10:00:00.000Z'),
    receivedAt: new Date('2026-06-27T10:00:00.100Z'),
  });

describe('DomainEventTypeormRepository.query', () => {
  it('builds an empty where-clause when no filter is supplied', async () => {
    const { repository: repoDouble, options } = makeQueryDouble();
    const repository = new DomainEventTypeormRepository(repoDouble);

    await repository.query({}, { page: 1, size: 20 });

    expect(options().where).toEqual({});
  });

  it('orders newest-first with an id tiebreaker', async () => {
    const { repository: repoDouble, options } = makeQueryDouble();
    const repository = new DomainEventTypeormRepository(repoDouble);

    await repository.query({}, { page: 1, size: 20 });

    expect(options().order).toEqual({ occurredAt: 'DESC', id: 'DESC' });
  });

  it('translates the 1-based page into skip / take', async () => {
    const { repository: repoDouble, options } = makeQueryDouble();
    const repository = new DomainEventTypeormRepository(repoDouble);

    await repository.query({}, { page: 3, size: 25 });

    expect(options().skip).toBe(50);
    expect(options().take).toBe(25);
  });

  it('maps each scalar filter onto one equality predicate', async () => {
    const { repository: repoDouble, options } = makeQueryDouble();
    const repository = new DomainEventTypeormRepository(repoDouble);

    await repository.query(
      {
        eventType: 'retail.order.placed',
        aggregateType: 'order',
        aggregateId: '42',
        correlationId: 'corr-1',
      },
      { page: 1, size: 20 },
    );

    expect(options().where).toEqual({
      eventType: 'retail.order.placed',
      aggregateType: 'order',
      aggregateId: '42',
      correlationId: 'corr-1',
    });
  });

  it('maps both occurredAt bounds onto Between', async () => {
    const { repository: repoDouble, options } = makeQueryDouble();
    const repository = new DomainEventTypeormRepository(repoDouble);

    await repository.query(
      { from: '2026-06-01T00:00:00.000Z', to: '2026-06-30T00:00:00.000Z' },
      { page: 1, size: 20 },
    );

    expect(options().where).toEqual({
      occurredAt: Between(
        new Date('2026-06-01T00:00:00.000Z'),
        new Date('2026-06-30T00:00:00.000Z'),
      ),
    });
  });

  it('maps a lone `from` onto MoreThanOrEqual and a lone `to` onto LessThanOrEqual', async () => {
    const { repository: fromDouble, options: fromOptions } = makeQueryDouble();
    await new DomainEventTypeormRepository(fromDouble).query(
      { from: '2026-06-01T00:00:00.000Z' },
      { page: 1, size: 20 },
    );
    expect(fromOptions().where).toEqual({
      occurredAt: MoreThanOrEqual(new Date('2026-06-01T00:00:00.000Z')),
    });

    const { repository: toDouble, options: toOptions } = makeQueryDouble();
    await new DomainEventTypeormRepository(toDouble).query(
      { to: '2026-06-30T00:00:00.000Z' },
      { page: 1, size: 20 },
    );
    expect(toOptions().where).toEqual({
      occurredAt: LessThanOrEqual(new Date('2026-06-30T00:00:00.000Z')),
    });
  });

  it('treats an unparseable ISO bound as absent rather than rejecting', async () => {
    const { repository: repoDouble, options } = makeQueryDouble();
    const repository = new DomainEventTypeormRepository(repoDouble);

    await repository.query({ from: 'not-a-date', to: 'also-not-a-date' }, { page: 1, size: 20 });

    expect(options().where).toEqual({});
  });

  it('maps the found entities to domain events and echoes total / page / size', async () => {
    const { repository: repoDouble } = makeQueryDouble([makeEntity()], 137);
    const repository = new DomainEventTypeormRepository(repoDouble);

    const page = await repository.query({}, { page: 3, size: 25 });

    expect(page.total).toBe(137);
    expect(page.page).toBe(3);
    expect(page.size).toBe(25);
    expect(page.items).toHaveLength(1);
    expect(page.items[0]).toBeInstanceOf(DomainEvent);
    expect(page.items[0].eventType).toBe('retail.order.placed');
  });
});
