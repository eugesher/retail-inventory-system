import { Between, FindManyOptions, LessThanOrEqual, MoreThanOrEqual, Repository } from 'typeorm';

import { AuditLogEntry } from '../../../domain';
import { AuditLogEntryEntity } from '../audit-log-entry.entity';
import { AuditLogEntryTypeormRepository } from '../audit-log-entry-typeorm.repository';

interface IQueryDouble {
  repository: Repository<AuditLogEntryEntity>;
  options: () => FindManyOptions<AuditLogEntryEntity>;
}

const makeQueryDouble = (rows: AuditLogEntryEntity[] = [], total = 0): IQueryDouble => {
  let captured: FindManyOptions<AuditLogEntryEntity> | undefined;
  const findAndCount = jest.fn((options: FindManyOptions<AuditLogEntryEntity>) => {
    captured = options;
    return Promise.resolve<[AuditLogEntryEntity[], number]>([rows, total]);
  });
  const find = jest.fn((options: FindManyOptions<AuditLogEntryEntity>) => {
    captured = options;
    return Promise.resolve(rows);
  });

  return {
    repository: { findAndCount, find } as unknown as Repository<AuditLogEntryEntity>,
    options: (): FindManyOptions<AuditLogEntryEntity> => {
      if (captured === undefined) {
        throw new Error('neither findAndCount nor find was called');
      }
      return captured;
    },
  };
};

interface IAppendDouble {
  repository: Repository<AuditLogEntryEntity>;
  insert: jest.Mock;
  partial: () => Record<string, unknown>;
}

const makeAppendDouble = (
  impl: () => Promise<unknown> = () => Promise.resolve({}),
): IAppendDouble => {
  let captured: Record<string, unknown> | undefined;
  const insert = jest.fn((row: Record<string, unknown>) => {
    captured = row;
    return impl();
  });

  return {
    repository: { insert } as unknown as Repository<AuditLogEntryEntity>,
    insert,
    partial: (): Record<string, unknown> => {
      if (captured === undefined) {
        throw new Error('insert was never called');
      }
      return captured;
    },
  };
};

const makeEntry = (): AuditLogEntry =>
  AuditLogEntry.create({
    actorId: 'staff-1',
    actorType: 'staff-user',
    action: 'StaffUserRolesAssigned',
    entityType: 'staff_user',
    entityId: '42',
    before: { roles: [] },
    after: { roles: ['admin'] },
    occurredAt: new Date('2026-06-27T10:00:00.000Z'),
    ipAddress: '203.0.113.7',
    correlationId: 'corr-1',
  });

const makeEntity = (): AuditLogEntryEntity =>
  Object.assign(new AuditLogEntryEntity(), {
    id: '7' as unknown as number,
    actorId: 'staff-1',
    actorType: 'staff-user' as const,
    action: 'StaffUserRolesAssigned',
    entityType: 'staff_user',
    entityId: '42',
    before: null,
    after: { roles: ['admin'] },
    occurredAt: new Date('2026-06-27T10:00:00.000Z'),
    ipAddress: null,
    correlationId: 'corr-1',
    receivedAt: new Date('2026-06-27T10:00:00.100Z'),
  });

describe('AuditLogEntryTypeormRepository.append', () => {
  it('INSERTs the mapped row (never `save` — the log is append-only)', async () => {
    const { repository: double, insert, partial } = makeAppendDouble();

    await new AuditLogEntryTypeormRepository(double).append(makeEntry());

    expect(insert).toHaveBeenCalledTimes(1);
    expect(partial()).toMatchObject({
      actorId: 'staff-1',
      actorType: 'staff-user',
      action: 'StaffUserRolesAssigned',
      entityType: 'staff_user',
      entityId: '42',
      correlationId: 'corr-1',
    });
  });

  it('omits the DB-owned columns — `id` and `receivedAt` are written by the database, not the mapper', async () => {
    const { repository: double, partial } = makeAppendDouble();

    await new AuditLogEntryTypeormRepository(double).append(makeEntry());

    expect(partial()).not.toHaveProperty('id');
    expect(partial()).not.toHaveProperty('receivedAt');
  });

  it('does NOT swallow a duplicate — unlike the domain-event log, which has a dedupe key and does', async () => {
    const dupError = Object.assign(new Error('duplicate'), { code: 'ER_DUP_ENTRY', errno: 1062 });
    const { repository: double } = makeAppendDouble(() => Promise.reject(dupError));

    await expect(new AuditLogEntryTypeormRepository(double).append(makeEntry())).rejects.toThrow(
      'duplicate',
    );
  });
});

describe('AuditLogEntryTypeormRepository.query', () => {
  it('builds an empty where-clause when no filter is supplied', async () => {
    const { repository: double, options } = makeQueryDouble();

    await new AuditLogEntryTypeormRepository(double).query({}, { page: 1, size: 20 });

    expect(options().where).toEqual({});
  });

  it('orders newest-first with an id tiebreaker', async () => {
    const { repository: double, options } = makeQueryDouble();

    await new AuditLogEntryTypeormRepository(double).query({}, { page: 1, size: 20 });

    expect(options().order).toEqual({ occurredAt: 'DESC', id: 'DESC' });
  });

  it('translates the 1-based page into skip / take', async () => {
    const { repository: double, options } = makeQueryDouble();

    await new AuditLogEntryTypeormRepository(double).query({}, { page: 3, size: 25 });

    expect(options().skip).toBe(50);
    expect(options().take).toBe(25);
  });

  it('maps each scalar filter onto one equality predicate', async () => {
    const { repository: double, options } = makeQueryDouble();

    await new AuditLogEntryTypeormRepository(double).query(
      {
        actorId: 'staff-1',
        entityType: 'staff_user',
        entityId: '42',
        action: 'StaffUserRolesAssigned',
        correlationId: 'corr-1',
      },
      { page: 1, size: 20 },
    );

    expect(options().where).toEqual({
      actorId: 'staff-1',
      entityType: 'staff_user',
      entityId: '42',
      action: 'StaffUserRolesAssigned',
      correlationId: 'corr-1',
    });
  });

  it('maps both occurredAt bounds onto Between', async () => {
    const { repository: double, options } = makeQueryDouble();

    await new AuditLogEntryTypeormRepository(double).query(
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
    await new AuditLogEntryTypeormRepository(fromDouble).query(
      { from: '2026-06-01T00:00:00.000Z' },
      { page: 1, size: 20 },
    );
    expect(fromOptions().where).toEqual({
      occurredAt: MoreThanOrEqual(new Date('2026-06-01T00:00:00.000Z')),
    });

    const { repository: toDouble, options: toOptions } = makeQueryDouble();
    await new AuditLogEntryTypeormRepository(toDouble).query(
      { to: '2026-06-30T00:00:00.000Z' },
      { page: 1, size: 20 },
    );
    expect(toOptions().where).toEqual({
      occurredAt: LessThanOrEqual(new Date('2026-06-30T00:00:00.000Z')),
    });
  });

  it('treats an unparseable ISO bound as absent rather than rejecting (and so routes through parseInstant)', async () => {
    const { repository: double, options } = makeQueryDouble();

    await new AuditLogEntryTypeormRepository(double).query(
      { from: 'not-a-date', to: 'also-not-a-date' },
      { page: 1, size: 20 },
    );

    expect(options().where).toEqual({});
  });

  it('maps the found entities to domain entries and echoes total / page / size', async () => {
    const { repository: double } = makeQueryDouble([makeEntity()], 137);

    const page = await new AuditLogEntryTypeormRepository(double).query({}, { page: 3, size: 25 });

    expect(page.total).toBe(137);
    expect(page.page).toBe(3);
    expect(page.size).toBe(25);
    expect(page.items).toHaveLength(1);
    expect(page.items[0]).toBeInstanceOf(AuditLogEntry);
    expect(page.items[0].action).toBe('StaffUserRolesAssigned');
    expect(page.items[0].id).toBe(7);
  });
});

describe('AuditLogEntryTypeormRepository.listByCorrelationId', () => {
  it('reads the trace forward (occurredAt ASC, id ASC), unpaginated', async () => {
    const { repository: double, options } = makeQueryDouble([makeEntity()]);

    const entries = await new AuditLogEntryTypeormRepository(double).listByCorrelationId('corr-1');

    expect(options().where).toEqual({ correlationId: 'corr-1' });
    expect(options().order).toEqual({ occurredAt: 'ASC', id: 'ASC' });
    expect(options().skip).toBeUndefined();
    expect(options().take).toBeUndefined();

    expect(entries).toHaveLength(1);
    expect(entries[0]).toBeInstanceOf(AuditLogEntry);
  });

  it('returns an empty array for a correlation id with no rows', async () => {
    const { repository: double } = makeQueryDouble([]);

    await expect(
      new AuditLogEntryTypeormRepository(double).listByCorrelationId('corr-missing'),
    ).resolves.toEqual([]);
  });
});
