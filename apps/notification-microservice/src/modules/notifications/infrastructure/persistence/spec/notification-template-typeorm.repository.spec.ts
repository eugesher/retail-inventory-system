import { FindManyOptions, FindOneOptions, Repository } from 'typeorm';

import { NotificationChannelEnum } from '@retail-inventory-system/contracts';

import {
  ICreateNotificationTemplateInput,
  NotificationErrorCodeEnum,
  NotificationTemplate,
} from '../../../domain';
import { NotificationTemplateEntity } from '../notification-template.entity';
import { NotificationTemplateTypeormRepository } from '../notification-template-typeorm.repository';

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

const duplicateError = (nested = false): Error => {
  const marker = { code: 'ER_DUP_ENTRY', errno: 1062 };
  return nested
    ? Object.assign(new Error('ER_DUP_ENTRY: UC_NOTIFICATION_TEMPLATE_NATURAL_KEY'), {
        driverError: marker,
      })
    : Object.assign(new Error('ER_DUP_ENTRY: UC_NOTIFICATION_TEMPLATE_NATURAL_KEY'), marker);
};

interface IRepoDouble {
  repository: Repository<NotificationTemplateEntity>;
  save: jest.Mock;
  findOne: jest.Mock;
  find: jest.Mock;
  maximum: jest.Mock;
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

  it('rethrows a non-duplicate write failure unchanged', async () => {
    const d = makeRepoDouble();
    d.save.mockRejectedValueOnce(new Error('ER_LOCK_WAIT_TIMEOUT'));

    await expect(
      new NotificationTemplateTypeormRepository(d.repository).save(
        NotificationTemplate.create(createInput()),
      ),
    ).rejects.toThrow('ER_LOCK_WAIT_TIMEOUT');
  });

  it.each([
    ['a bare string', 'ER_DUP_ENTRY'],
    ['null', null],
  ])('does not mistake %s for a duplicate-entry error', async (_label, rejection) => {
    const d = makeRepoDouble();
    d.save.mockRejectedValueOnce(rejection);

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

  it('treats activeOnly:false as no narrowing at all, not as active=false', async () => {
    const d = makeRepoDouble();

    await new NotificationTemplateTypeormRepository(d.repository).list({ activeOnly: false });

    expect(d.lastFind().where).toEqual({});
  });

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
