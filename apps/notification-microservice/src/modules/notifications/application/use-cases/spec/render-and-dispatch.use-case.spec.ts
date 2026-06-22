import { PinoLogger } from 'nestjs-pino';

import {
  NotificationChannelEnum,
  NotificationDeliveryStatusEnum,
} from '@retail-inventory-system/contracts';

import { Notification, NotificationDelivery, NotificationTemplate } from '../../../domain';
import {
  INotificationDeliveryPage,
  INotificationDeliveryRepositoryPort,
  INotificationTemplateRepositoryPort,
  INotifierPort,
  ITemplateRendererPort,
} from '../../ports';
import { IRenderAndDispatchInput, RenderAndDispatchUseCase } from '../render-and-dispatch.use-case';
import { FakeLogger } from './test-doubles';

// A template repo whose only live method is `findLatestActive` — the render hot path. The
// other port methods are unreachable in this pipeline and throw if touched (a regression
// guard: the use case must not reach for them).
class FakeTemplateRepo implements INotificationTemplateRepositoryPort {
  public latest: NotificationTemplate | null = null;
  public readonly findLatestActiveCalls: {
    eventType: string;
    channel: NotificationChannelEnum;
    locale: string;
  }[] = [];

  public findLatestActive(
    eventType: string,
    channel: NotificationChannelEnum,
    locale: string,
  ): Promise<NotificationTemplate | null> {
    this.findLatestActiveCalls.push({ eventType, channel, locale });
    return Promise.resolve(this.latest);
  }

  public save(): Promise<NotificationTemplate> {
    throw new Error('not used in render & dispatch');
  }
  public findById(): Promise<NotificationTemplate | null> {
    throw new Error('not used in render & dispatch');
  }
  public findByNaturalKey(): Promise<NotificationTemplate | null> {
    throw new Error('not used in render & dispatch');
  }
  public maxVersion(): Promise<number | null> {
    throw new Error('not used in render & dispatch');
  }
  public list(): Promise<NotificationTemplate[]> {
    throw new Error('not used in render & dispatch');
  }
}

// A delivery repo that simulates persistence: `save` of an id-less row assigns a fresh
// BIGINT (via `reconstitute`) and snapshots the status at save time, so a spec can prove
// the FIRST save persisted a `queued` row. `findByDedupeKey` returns whatever `existing`
// is set to (the idempotency pre-check). All calls are appended to the shared `events`
// log so a spec can assert the persist-before-dispatch ordering.
class RecordingDeliveryRepo implements INotificationDeliveryRepositoryPort {
  public existing: NotificationDelivery | null = null;
  public readonly saved: NotificationDelivery[] = [];
  public readonly savedStatuses: NotificationDeliveryStatusEnum[] = [];
  private seq = 0;

  constructor(private readonly events: string[]) {}

  public save(delivery: NotificationDelivery): Promise<NotificationDelivery> {
    this.events.push('delivery.save');
    this.savedStatuses.push(delivery.status);
    if (delivery.id === null) {
      const persisted = NotificationDelivery.reconstitute({
        id: ++this.seq,
        templateId: delivery.templateId,
        recipientCustomerId: delivery.recipientCustomerId,
        recipientAddress: delivery.recipientAddress,
        channel: delivery.channel,
        eventReferenceType: delivery.eventReferenceType,
        eventReferenceId: delivery.eventReferenceId,
        status: delivery.status,
        attemptCount: delivery.attemptCount,
        lastAttemptAt: delivery.lastAttemptAt,
        failureReason: delivery.failureReason,
        renderedSubject: delivery.renderedSubject,
        renderedBody: delivery.renderedBody,
        correlationId: delivery.correlationId,
      });
      this.saved.push(persisted);
      return Promise.resolve(persisted);
    }
    this.saved.push(delivery);
    return Promise.resolve(delivery);
  }

  public findByDedupeKey(): Promise<NotificationDelivery | null> {
    return Promise.resolve(this.existing);
  }

  public findById(): Promise<NotificationDelivery | null> {
    throw new Error('not used in render & dispatch');
  }
  public list(): Promise<INotificationDeliveryPage> {
    throw new Error('not used in render & dispatch');
  }
  public listRetryable(): Promise<NotificationDelivery[]> {
    throw new Error('not used in render & dispatch');
  }
}

// A renderer double that does naive `{{key}}` substitution from the context, so a spec can
// assert deterministic rendered output without coupling to the real Handlebars engine.
class FakeRenderer implements ITemplateRendererPort {
  public readonly calls: { source: string; context: Record<string, unknown> }[] = [];

  public render(source: string, context: Record<string, unknown>): string {
    this.calls.push({ source, context });
    return source.replace(/\{\{\s*(\w+)\s*\}\}/g, (_match, key: string) => {
      const value = context[key];
      if (value === null || value === undefined) {
        return '';
      }
      return typeof value === 'string' ? value : String(value as number | boolean);
    });
  }
}

// A notifier that records what it was handed and can be told to throw (a transport
// failure). Appends to the shared `events` log for the ordering assertion.
class RecordingNotifier implements INotifierPort {
  public readonly sent: Notification[] = [];
  public shouldThrow = false;
  public readonly error = new Error('smtp down');

  constructor(private readonly events: string[]) {}

  public send(notification: Notification): Promise<void> {
    this.events.push('notifier.send');
    if (this.shouldThrow) {
      return Promise.reject(this.error);
    }
    this.sent.push(notification);
    return Promise.resolve();
  }
}

describe('RenderAndDispatchUseCase', () => {
  let events: string[];
  let templateRepo: FakeTemplateRepo;
  let deliveryRepo: RecordingDeliveryRepo;
  let renderer: FakeRenderer;
  let notifier: RecordingNotifier;
  let logger: FakeLogger;
  let useCase: RenderAndDispatchUseCase;

  // An email template (subject-bearing) at version 1, persisted (id non-null).
  const emailTemplate = (): NotificationTemplate =>
    NotificationTemplate.reconstitute({
      id: 7,
      eventType: 'retail.order.placed',
      channel: NotificationChannelEnum.EMAIL,
      locale: 'en-US',
      subject: 'Hello {{name}}',
      body: 'Order {{orderId}} confirmed',
      version: 1,
      active: true,
    });

  const buildInput = (
    overrides: Partial<IRenderAndDispatchInput> = {},
  ): IRenderAndDispatchInput => ({
    eventType: 'retail.order.placed',
    channel: NotificationChannelEnum.EMAIL,
    recipientCustomerId: 'cust-uuid-1',
    recipientAddress: 'ada@example.com',
    eventReferenceType: 'order',
    eventReferenceId: '99',
    context: { name: 'Ada', orderId: 99 },
    correlationId: 'corr-1',
    ...overrides,
  });

  beforeEach(() => {
    events = [];
    templateRepo = new FakeTemplateRepo();
    deliveryRepo = new RecordingDeliveryRepo(events);
    renderer = new FakeRenderer();
    notifier = new RecordingNotifier(events);
    logger = new FakeLogger();
    useCase = new RenderAndDispatchUseCase(
      templateRepo,
      deliveryRepo,
      renderer,
      notifier,
      logger as unknown as PinoLogger,
    );
  });

  it('renders the template subject/body for the context and dispatches them', async () => {
    templateRepo.latest = emailTemplate();

    const result = await useCase.execute(buildInput());

    expect(result).not.toBeNull();
    expect(result?.renderedSubject).toBe('Hello Ada');
    expect(result?.renderedBody).toBe('Order 99 confirmed');

    expect(notifier.sent).toHaveLength(1);
    expect(notifier.sent[0].subject).toBe('Hello Ada');
    expect(notifier.sent[0].body).toBe('Order 99 confirmed');
    expect(notifier.sent[0].recipient).toBe('ada@example.com');
    expect(notifier.sent[0].channel).toBe(NotificationChannelEnum.EMAIL);

    // The template was resolved on the requested key, defaulting the locale.
    expect(templateRepo.findLatestActiveCalls[0]).toEqual({
      eventType: 'retail.order.placed',
      channel: NotificationChannelEnum.EMAIL,
      locale: 'en-US',
    });
  });

  it('persists the delivery row in queued BEFORE calling the notifier', async () => {
    templateRepo.latest = emailTemplate();

    await useCase.execute(buildInput());

    // The FIRST save persisted a `queued` row...
    expect(deliveryRepo.savedStatuses[0]).toBe(NotificationDeliveryStatusEnum.QUEUED);
    // ...and it happened strictly before the notifier was called.
    expect(events.indexOf('delivery.save')).toBeGreaterThanOrEqual(0);
    expect(events.indexOf('notifier.send')).toBeGreaterThan(events.indexOf('delivery.save'));
  });

  it('flips the row to sent (attemptCount=1, lastAttemptAt set) on notifier success', async () => {
    templateRepo.latest = emailTemplate();

    const result = await useCase.execute(buildInput());

    expect(result?.status).toBe(NotificationDeliveryStatusEnum.SENT);
    expect(result?.attemptCount).toBe(1);
    expect(result?.lastAttemptAt).toBeInstanceOf(Date);
    expect(result?.failureReason).toBeNull();
  });

  it('records the row as failed (attemptCount=1, failureReason set) without rethrowing when the notifier throws', async () => {
    templateRepo.latest = emailTemplate();
    notifier.shouldThrow = true;

    // The use case must NOT rethrow — the failure is recorded on the row.
    const result = await useCase.execute(buildInput());

    expect(result?.status).toBe(NotificationDeliveryStatusEnum.FAILED);
    expect(result?.attemptCount).toBe(1);
    expect(result?.lastAttemptAt).toBeInstanceOf(Date);
    expect(result?.failureReason).toBe('smtp down');
    // Still persisted before the (failed) send — the audit row exists regardless.
    expect(deliveryRepo.savedStatuses[0]).toBe(NotificationDeliveryStatusEnum.QUEUED);
    expect(
      logger.warns.some((w) => w.message === 'Notification dispatch failed; recorded for retry'),
    ).toBe(true);
  });

  it('persists no delivery row and does not throw when no active template resolves', async () => {
    templateRepo.latest = null;

    const result = await useCase.execute(buildInput());

    expect(result).toBeNull();
    expect(deliveryRepo.saved).toHaveLength(0);
    expect(notifier.sent).toHaveLength(0);
    expect(renderer.calls).toHaveLength(0);
    expect(
      logger.warns.some(
        (w) => w.message === 'No active notification template found; skipping delivery',
      ),
    ).toBe(true);
  });

  it('persists no row and does not throw when the template renders an empty body', async () => {
    // A body that references a context key the event never carries renders to '' (the
    // FakeRenderer substitutes a missing key with empty). The use case runs inside an
    // `@EventPattern` consumer, so an empty render must warn-and-skip (like a missing
    // template) rather than let `NotificationDelivery.open`'s non-empty-body guard throw
    // out of the handler and blind-redeliver the event.
    templateRepo.latest = NotificationTemplate.reconstitute({
      id: 7,
      eventType: 'retail.order.placed',
      channel: NotificationChannelEnum.EMAIL,
      locale: 'en-US',
      subject: 'Hello {{name}}',
      body: '{{missingField}}',
      version: 1,
      active: true,
    });

    const result = await useCase.execute(buildInput({ context: { name: 'Ada' } }));

    expect(result).toBeNull();
    expect(deliveryRepo.saved).toHaveLength(0);
    expect(notifier.sent).toHaveLength(0);
    expect(
      logger.warns.some((w) => w.message === 'Template rendered an empty body; skipping delivery'),
    ).toBe(true);
  });

  it('returns the existing row and does NOT re-dispatch on a dedupe collision (customer-facing)', async () => {
    templateRepo.latest = emailTemplate();
    const alreadySent = NotificationDelivery.reconstitute({
      id: 555,
      templateId: 7,
      recipientCustomerId: 'cust-uuid-1',
      recipientAddress: 'ada@example.com',
      channel: NotificationChannelEnum.EMAIL,
      eventReferenceType: 'order',
      eventReferenceId: '99',
      status: NotificationDeliveryStatusEnum.SENT,
      attemptCount: 1,
      lastAttemptAt: new Date('2026-06-21T10:00:00.000Z'),
      failureReason: null,
      renderedSubject: 'Hello Ada',
      renderedBody: 'Order 99 confirmed',
      correlationId: 'corr-earlier',
    });
    deliveryRepo.existing = alreadySent;

    const result = await useCase.execute(buildInput());

    expect(result).toBe(alreadySent);
    // No new row saved, no second NOTIFIER call.
    expect(deliveryRepo.saved).toHaveLength(0);
    expect(notifier.sent).toHaveLength(0);
    expect(events).not.toContain('notifier.send');
    expect(logger.logs.some((l) => l.message === 'Duplicate delivery, skipping dispatch')).toBe(
      true,
    );
  });

  it('does not run the dedupe pre-check for a system/ops (null-recipient) notification', async () => {
    templateRepo.latest = emailTemplate();
    // Even if a stale row were present, a null-recipient delivery is never deduped — the
    // pre-check is skipped, so this row must not short-circuit the dispatch.
    deliveryRepo.existing = NotificationDelivery.reconstitute({
      id: 1,
      templateId: 7,
      recipientCustomerId: null,
      recipientAddress: 'ops@example.com',
      channel: NotificationChannelEnum.EMAIL,
      eventReferenceType: 'stock-low',
      eventReferenceId: '42',
      status: NotificationDeliveryStatusEnum.SENT,
      attemptCount: 1,
      lastAttemptAt: new Date(),
      failureReason: null,
      renderedSubject: 'x',
      renderedBody: 'y',
      correlationId: 'c',
    });

    const result = await useCase.execute(
      buildInput({ recipientCustomerId: null, recipientAddress: 'ops@example.com' }),
    );

    expect(result?.status).toBe(NotificationDeliveryStatusEnum.SENT);
    expect(notifier.sent).toHaveLength(1);
  });

  it('falls back to the eventType as the transport subject for a null-subject (sms/push) template', async () => {
    templateRepo.latest = NotificationTemplate.reconstitute({
      id: 9,
      eventType: 'retail.order.placed',
      channel: NotificationChannelEnum.SMS,
      locale: 'en-US',
      subject: null,
      body: 'Order {{orderId}} confirmed',
      version: 1,
      active: true,
    });

    const result = await useCase.execute(buildInput({ channel: NotificationChannelEnum.SMS }));

    // The persisted row keeps a null rendered subject (sms carries no subject line)...
    expect(result?.renderedSubject).toBeNull();
    // ...but the transport (which requires a non-empty subject) gets the eventType fallback.
    expect(notifier.sent[0].subject).toBe('retail.order.placed');
    expect(notifier.sent[0].body).toBe('Order 99 confirmed');
  });
});
