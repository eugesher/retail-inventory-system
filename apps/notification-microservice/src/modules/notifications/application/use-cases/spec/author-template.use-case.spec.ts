import { PinoLogger } from 'nestjs-pino';

import {
  INotificationTemplateAuthorPayload,
  NotificationChannelEnum,
} from '@retail-inventory-system/contracts';

import {
  NotificationDomainException,
  NotificationErrorCodeEnum,
  NotificationTemplate,
} from '../../../domain';
import { AuthorTemplateUseCase } from '../author-template.use-case';
import { FakeLogger, InMemoryTemplateRepo } from './test-doubles';

// `AuthorTemplateUseCase` is the registry's create-or-edit write: a first author for a
// `(eventType, channel, locale)` key writes `version = 1`; every later author appends a
// new row at `(maxVersion ?? 0) + 1`, retaining the prior versions. The channel-specific
// subject rule (from `NotificationTemplate.create`) rejects an `email` author with no
// subject, and a derived-version collision is a typed `TEMPLATE_DUPLICATE_VERSION`.
describe('AuthorTemplateUseCase', () => {
  let repo: InMemoryTemplateRepo;
  let useCase: AuthorTemplateUseCase;

  beforeEach(() => {
    repo = new InMemoryTemplateRepo();
    useCase = new AuthorTemplateUseCase(repo, new FakeLogger() as unknown as PinoLogger);
  });

  const basePayload = (
    overrides: Partial<INotificationTemplateAuthorPayload> = {},
  ): INotificationTemplateAuthorPayload => ({
    eventType: 'retail.order.placed',
    channel: NotificationChannelEnum.EMAIL,
    locale: 'en-US',
    subject: 'Order {{orderNumber}} confirmed',
    body: 'Hi {{customerName}}, your order is in.',
    correlationId: 'corr-author',
    ...overrides,
  });

  it('opens the first author at version=1, active', async () => {
    const view = await useCase.execute(basePayload());

    expect(view.version).toBe(1);
    expect(view.active).toBe(true);
    expect(view.id).toEqual(expect.any(Number));
    expect(view.eventType).toBe('retail.order.placed');
    expect(repo.rows).toHaveLength(1);
  });

  it('auto-increments a second author for the same key to version=2 and retains version 1', async () => {
    const first = await useCase.execute(basePayload({ body: 'v1 body' }));
    const second = await useCase.execute(basePayload({ body: 'v2 body' }));

    expect(first.version).toBe(1);
    expect(second.version).toBe(2);
    // Both versions are retained — the edit appended rather than overwrote.
    expect(repo.rows).toHaveLength(2);
    const versions = repo.rows.map((r) => r.version).sort();
    expect(versions).toEqual([1, 2]);
  });

  it('keys the version per (eventType, channel, locale) — a different key restarts at 1', async () => {
    await useCase.execute(basePayload());
    const other = await useCase.execute(
      basePayload({ eventType: 'retail.refund.issued', body: 'refund body' }),
    );

    expect(other.version).toBe(1);
  });

  it('rejects a derived-version collision with TEMPLATE_DUPLICATE_VERSION', async () => {
    // Simulate a concurrent author having inserted version 1 between our maxVersion read
    // (empty ⇒ next = 1) and the natural-key safety-net check.
    const racer = NotificationTemplate.reconstitute({
      id: 99,
      eventType: 'retail.order.placed',
      channel: NotificationChannelEnum.EMAIL,
      locale: 'en-US',
      subject: 'subj',
      body: 'body',
      version: 1,
      active: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    jest.spyOn(repo, 'findByNaturalKey').mockResolvedValue(racer);

    await expect(useCase.execute(basePayload())).rejects.toMatchObject({
      code: NotificationErrorCodeEnum.TEMPLATE_DUPLICATE_VERSION,
    });
    await expect(useCase.execute(basePayload())).rejects.toBeInstanceOf(
      NotificationDomainException,
    );
  });

  it('enforces the channel-specific subject rule — an email author with no subject is rejected', async () => {
    await expect(useCase.execute(basePayload({ subject: undefined }))).rejects.toMatchObject({
      code: NotificationErrorCodeEnum.TEMPLATE_SUBJECT_REQUIRED,
    });
    // Nothing was persisted — the invariant fired before save.
    expect(repo.rows).toHaveLength(0);
  });

  it('allows a null-subject author on a subject-optional channel (sms)', async () => {
    const view = await useCase.execute(
      basePayload({ channel: NotificationChannelEnum.SMS, subject: undefined }),
    );

    expect(view.subject).toBeNull();
    expect(view.version).toBe(1);
  });
});
