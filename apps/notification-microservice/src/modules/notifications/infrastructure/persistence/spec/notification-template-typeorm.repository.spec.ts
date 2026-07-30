import { FindManyOptions, FindOneOptions, Repository } from 'typeorm';

import { NotificationChannelEnum } from '@retail-inventory-system/contracts';

import {
  ICreateNotificationTemplateInput,
  NotificationErrorCodeEnum,
  NotificationTemplate,
} from '../../../domain';
import { NotificationTemplateEntity } from '../notification-template.entity';
import { NotificationTemplateTypeormRepository } from '../notification-template-typeorm.repository';

// The template repository had no spec, while its delivery sibling did — and the asymmetry sat on
// the one branch that matters most in both: the `ER_DUP_ENTRY` translation. The delivery repo turns
// a collision into an idempotent re-read; this one turns it into a typed 409. Neither is reachable
// from a use-case spec (nothing above the repository can make MySQL raise 1062), and an e2e cannot
// provoke it either without racing two authors on the same version for real. So it went unasserted
// on this side, in a repository that is otherwise pure translation — a `where` clause, an `order`,
// a branch on a driver error code. That is exactly the code that fails by returning a plausible
// answer rather than by throwing.

const createInput = (
  overrides: Partial<ICreateNotificationTemplateInput> = {},
): ICreateNotificationTemplateInput => ({
  eventType: 'retail.order.placed',
  channel: NotificationChannelEnum.EMAIL,
  locale: 'en-US',
  subject: 'Order {{orderNumber}} confirmed',
  body: 'Hi {{customerName}}, we received your order.',
  version: 2,
  ...overrides,
});

const makeEntity = (
  overrides: Partial<NotificationTemplateEntity> = {},
): NotificationTemplateEntity =>
  Object.assign(new NotificationTemplateEntity(), {
    id: 7,
    eventType: 'retail.order.placed',
    channel: NotificationChannelEnum.EMAIL,
    locale: 'en-US',
    subject: 'Order {{orderNumber}} confirmed',
    body: 'Hi {{customerName}}, we received your order.',
    version: 2,
    active: true,
    createdAt: new Date('2026-06-27T10:00:00.000Z'),
    updatedAt: new Date('2026-06-27T10:00:00.000Z'),
    deletedAt: null,
    ...overrides,
  });

// The driver error the natural-key UNIQUE raises. Duck-typed exactly as `isDuplicateEntryError`
// reads it — the predicate accepts the marker at the top level OR nested under `driverError`, so a
// spec that only ever built one shape would leave half the predicate unexercised.
const duplicateError = (nested = false): Error => {
  const marker = { code: 'ER_DUP_ENTRY', errno: 1062 };
  return nested
    ? Object.assign(new Error('ER_DUP_ENTRY: UC_NOTIFICATION_TEMPLATE_NATURAL_KEY'), {
        driverError: marker,
      })
    : Object.assign(new Error('ER_DUP_ENTRY: UC_NOTIFICATION_TEMPLATE_NATURAL_KEY'), marker);
};

// The `Repository` surface this class actually touches. The double is deliberately dumb: the logic
// under test is the repository's translation, not TypeORM's.
interface IRepoDouble {
  repository: Repository<NotificationTemplateEntity>;
  save: jest.Mock;
  findOne: jest.Mock;
  find: jest.Mock;
  maximum: jest.Mock;
  // The next `findOne` answer. A test must NOT reach for `findOne.mockResolvedValueOnce`: that
  // replaces the implementation, so the closure below never runs and the captured options stay
  // undefined — a double that silently stops recording is worse than one that never recorded.
  programFindOne: (result: NotificationTemplateEntity | null) => void;
  lastFindOne: () => FindOneOptions<NotificationTemplateEntity>;
  lastFind: () => FindManyOptions<NotificationTemplateEntity>;
}

const makeRepoDouble = (): IRepoDouble => {
  let findOneOptions: FindOneOptions<NotificationTemplateEntity> | undefined;
  let findOptions: FindManyOptions<NotificationTemplateEntity> | undefined;
  const findOneQueue: (NotificationTemplateEntity | null)[] = [];

  const save = jest.fn((entity: NotificationTemplateEntity) =>
    Promise.resolve({ ...entity, id: 7 }),
  );
  const findOne = jest.fn((options: FindOneOptions<NotificationTemplateEntity>) => {
    findOneOptions = options;
    const next = findOneQueue.length > 0 ? findOneQueue.shift()! : makeEntity();
    return Promise.resolve(next);
  });
  const find = jest.fn((options: FindManyOptions<NotificationTemplateEntity>) => {
    findOptions = options;
    return Promise.resolve([makeEntity()]);
  });
  const maximum = jest.fn(() => Promise.resolve(4));

  return {
    repository: {
      save,
      findOne,
      find,
      maximum,
    } as unknown as Repository<NotificationTemplateEntity>,
    save,
    findOne,
    find,
    maximum,
    programFindOne: (result: NotificationTemplateEntity | null): void => {
      findOneQueue.push(result);
    },
    lastFindOne: (): FindOneOptions<NotificationTemplateEntity> => {
      if (findOneOptions === undefined) {
        throw new Error('findOne was never called');
      }
      return findOneOptions;
    },
    lastFind: (): FindManyOptions<NotificationTemplateEntity> => {
      if (findOptions === undefined) {
        throw new Error('find was never called');
      }
      return findOptions;
    },
  };
};

describe('NotificationTemplateTypeormRepository.save', () => {
  it('re-reads the committed row so the caller gets the generated id and timestamps', async () => {
    const d = makeRepoDouble();

    const saved = await new NotificationTemplateTypeormRepository(d.repository).save(
      NotificationTemplate.create(createInput()),
    );

    expect(d.save).toHaveBeenCalledTimes(1);
    expect(saved.id).toBe(7);
    expect(saved.createdAt).toEqual(new Date('2026-06-27T10:00:00.000Z'));
  });

  // **The TOCTOU race the Author use case cannot close.** `AuthorTemplateUseCase` reads
  // `maxVersion`, derives `+ 1`, then checks `findByNaturalKey` — and a concurrent author can slip
  // between the read and the write. The pre-check is a courtesy; the natural-key UNIQUE is the real
  // backstop. This branch is what makes losing that race a typed 409 instead of a raw driver error
  // surfacing as a 500.
  it('translates the natural-key collision into TEMPLATE_DUPLICATE_VERSION', async () => {
    const d = makeRepoDouble();
    d.save.mockRejectedValueOnce(duplicateError());

    await expect(
      new NotificationTemplateTypeormRepository(d.repository).save(
        NotificationTemplate.create(createInput()),
      ),
    ).rejects.toMatchObject({
      code: NotificationErrorCodeEnum.TEMPLATE_DUPLICATE_VERSION,
    });
  });

  // The same marker, nested under `driverError` — the shape TypeORM produces when it wraps the
  // mysql2 error in a `QueryFailedError`. `isDuplicateEntryError` reads both, and a spec that only
  // built the flat shape would leave the wrapped one — the one production actually sees — untested.
  it('recognises the collision when the driver error is nested under driverError', async () => {
    const d = makeRepoDouble();
    d.save.mockRejectedValueOnce(duplicateError(true));

    await expect(
      new NotificationTemplateTypeormRepository(d.repository).save(
        NotificationTemplate.create(createInput()),
      ),
    ).rejects.toMatchObject({
      code: NotificationErrorCodeEnum.TEMPLATE_DUPLICATE_VERSION,
    });
  });

  // **And it must NOT translate anything else.** Swallowing a non-duplicate write failure into a
  // "duplicate version" 409 would tell an operator to bump a version number over a disk-full or a
  // dropped connection — a wrong answer that reads as a plausible one.
  it('rethrows a non-duplicate write failure unchanged', async () => {
    const d = makeRepoDouble();
    d.save.mockRejectedValueOnce(new Error('ER_LOCK_WAIT_TIMEOUT'));

    await expect(
      new NotificationTemplateTypeormRepository(d.repository).save(
        NotificationTemplate.create(createInput()),
      ),
    ).rejects.toThrow('ER_LOCK_WAIT_TIMEOUT');
  });

  // `isDuplicateEntryError` is handed an `unknown`, and a driver really can reject with a bare
  // string or a `null` — the same hostile-driver case the retry doubles simulate. Its
  // `typeof !== 'object'` guard is what keeps the predicate from dereferencing one; without it a
  // string rejection would throw INSIDE the `catch`, replacing a legible write failure with a
  // TypeError raised while handling it.
  it.each([
    ['a bare string', 'ER_DUP_ENTRY'],
    ['null', null],
  ])('does not mistake %s for a duplicate-entry error', async (_label, rejection) => {
    const d = makeRepoDouble();
    d.save.mockRejectedValueOnce(rejection);

    // Rethrown unchanged — not translated, and not swallowed by a crash in the predicate.
    await expect(
      new NotificationTemplateTypeormRepository(d.repository).save(
        NotificationTemplate.create(createInput()),
      ),
    ).rejects.toBe(rejection);
  });

  it('treats a row that vanished between write and re-read as an invariant breach', async () => {
    const d = makeRepoDouble();
    d.programFindOne(null);

    await expect(
      new NotificationTemplateTypeormRepository(d.repository).save(
        NotificationTemplate.create(createInput()),
      ),
    ).rejects.toThrow('vanished after commit');
  });
});

describe('NotificationTemplateTypeormRepository.findById', () => {
  it('resolves a missing row to null rather than throwing', async () => {
    const d = makeRepoDouble();
    d.programFindOne(null);

    const found = await new NotificationTemplateTypeormRepository(d.repository).findById(404);

    expect(found).toBeNull();
    expect(d.lastFindOne().where).toEqual({ id: 404 });
  });

  it('maps a found row to the domain aggregate', async () => {
    const d = makeRepoDouble();

    const found = await new NotificationTemplateTypeormRepository(d.repository).findById(7);

    expect(found).toBeInstanceOf(NotificationTemplate);
    expect(found?.version).toBe(2);
  });
});

describe('NotificationTemplateTypeormRepository.findLatestActive', () => {
  // The hot path — the render pipeline runs it on every outgoing notification. Two things make it
  // correct and both are invisible from the call site: `active: true` in the `where`, and
  // `version: 'DESC'`. Drop the ordering and the query still returns *a* template; it just stops
  // being the live one, which is the failure that ships wrong copy rather than an error.
  it('scopes to the active rows for the key and takes the highest version', async () => {
    const d = makeRepoDouble();

    const found = await new NotificationTemplateTypeormRepository(d.repository).findLatestActive(
      'retail.order.placed',
      NotificationChannelEnum.EMAIL,
      'en-US',
    );

    expect(d.lastFindOne().where).toEqual({
      eventType: 'retail.order.placed',
      channel: NotificationChannelEnum.EMAIL,
      locale: 'en-US',
      active: true,
    });
    expect(d.lastFindOne().order).toEqual({ version: 'DESC' });
    expect(found).toBeInstanceOf(NotificationTemplate);
  });

  // A key with no active template is a seed/config gap, not an error: `RenderAndDispatchUseCase`
  // warns and skips without persisting a delivery row.
  it('resolves to null when the key has no active template', async () => {
    const d = makeRepoDouble();
    d.programFindOne(null);

    const found = await new NotificationTemplateTypeormRepository(d.repository).findLatestActive(
      'retail.order.placed',
      NotificationChannelEnum.EMAIL,
      'fr-FR',
    );

    expect(found).toBeNull();
  });
});

describe('NotificationTemplateTypeormRepository.findByNaturalKey', () => {
  // The version-specific lookup, and note what is ABSENT from the `where`: `active`. This is the
  // duplicate-version pre-check, and a deactivated row still occupies its version — scoping this to
  // active rows would report a taken version as free and hand the collision to the UNIQUE.
  it('queries all four key columns and does not filter on active', async () => {
    const d = makeRepoDouble();

    await new NotificationTemplateTypeormRepository(d.repository).findByNaturalKey(
      'retail.order.placed',
      NotificationChannelEnum.EMAIL,
      'en-US',
      3,
    );

    expect(d.lastFindOne().where).toEqual({
      eventType: 'retail.order.placed',
      channel: NotificationChannelEnum.EMAIL,
      locale: 'en-US',
      version: 3,
    });
  });

  it('resolves an absent version to null', async () => {
    const d = makeRepoDouble();
    d.programFindOne(null);

    const found = await new NotificationTemplateTypeormRepository(d.repository).findByNaturalKey(
      'retail.order.placed',
      NotificationChannelEnum.EMAIL,
      'en-US',
      99,
    );

    expect(found).toBeNull();
  });
});

describe('NotificationTemplateTypeormRepository.maxVersion', () => {
  // The high-water mark across ALL rows for the key, active or not. That "or not" is the whole
  // point: a rollback deactivates the newest version, and if this only counted active rows the next
  // author would derive a version that already exists — turning every edit-after-rollback into a
  // 409 (or, past the pre-check, a UNIQUE violation).
  it('reads the maximum over the key without filtering on active', async () => {
    const d = makeRepoDouble();

    const max = await new NotificationTemplateTypeormRepository(d.repository).maxVersion(
      'retail.order.placed',
      NotificationChannelEnum.EMAIL,
      'en-US',
    );

    expect(d.maximum).toHaveBeenCalledWith('version', {
      eventType: 'retail.order.placed',
      channel: NotificationChannelEnum.EMAIL,
      locale: 'en-US',
    });
    expect(max).toBe(4);
  });

  // A key with no rows at all. TypeORM's `maximum` answers `null` there, and the Author use case
  // reads it as `(null ?? 0) + 1 = 1` — the first version. Normalising `undefined` to `null` is what
  // keeps that `??` from seeing `undefined` and the first author from writing `NaN`.
  it('normalises an absent maximum to null so the first author starts at version 1', async () => {
    const d = makeRepoDouble();
    d.maximum.mockResolvedValueOnce(undefined);

    const max = await new NotificationTemplateTypeormRepository(d.repository).maxVersion(
      'brand.new.key',
      NotificationChannelEnum.EMAIL,
      'en-US',
    );

    expect(max).toBeNull();
  });
});

describe('NotificationTemplateTypeormRepository.list', () => {
  // Every filter field is optional and NARROWS: an absent one must not appear in the `where` at
  // all. TypeORM drops an `undefined` from a where clause rather than matching nothing, so a naive
  // spread would happen to work — until a caller passes an explicit `undefined` and the query
  // silently widens. Building the object conditionally is what makes "absent" and "any" the same
  // thing on purpose rather than by accident.
  it('omits an absent filter from the where clause entirely', async () => {
    const d = makeRepoDouble();

    await new NotificationTemplateTypeormRepository(d.repository).list({});

    expect(d.lastFind().where).toEqual({});
  });

  it('narrows on each supplied filter', async () => {
    const d = makeRepoDouble();

    await new NotificationTemplateTypeormRepository(d.repository).list({
      eventType: 'retail.order.placed',
      channel: NotificationChannelEnum.EMAIL,
      locale: 'en-US',
      activeOnly: true,
    });

    expect(d.lastFind().where).toEqual({
      eventType: 'retail.order.placed',
      channel: NotificationChannelEnum.EMAIL,
      locale: 'en-US',
      active: true,
    });
  });

  // `activeOnly` is checked with `=== true`, so `false` means "do not narrow" rather than
  // "active must be false". The registry browse's whole job is showing retired versions alongside
  // live ones; an `activeOnly: false` that filtered for INACTIVE rows would invert it.
  it('treats activeOnly:false as no narrowing at all, not as active=false', async () => {
    const d = makeRepoDouble();

    await new NotificationTemplateTypeormRepository(d.repository).list({ activeOnly: false });

    expect(d.lastFind().where).toEqual({});
  });

  // Versions of one key must group together with the live one on top — that is what makes the
  // browse readable as a history, and what an operator picks a rollback target from.
  it('orders by the key ascending with versions newest-first', async () => {
    const d = makeRepoDouble();

    const rows = await new NotificationTemplateTypeormRepository(d.repository).list({});

    expect(d.lastFind().order).toEqual({
      eventType: 'ASC',
      channel: 'ASC',
      locale: 'ASC',
      version: 'DESC',
    });
    expect(rows[0]).toBeInstanceOf(NotificationTemplate);
  });
});
