import {
  NotificationChannelEnum,
  NotificationDeliveryStatusEnum,
} from '@retail-inventory-system/contracts';

import { NotificationDelivery, NotificationTemplate } from '../../../domain';
import {
  INotificationDeliveryListFilter,
  INotificationDeliveryPage,
  INotificationDeliveryPageRequest,
  INotificationDeliveryRepositoryPort,
  INotificationTemplateListFilter,
  INotificationTemplateRepositoryPort,
} from '../../ports';

// Rejects with a value that is NOT an `Error`.
//
// Production code must never do this, and `@typescript-eslint/prefer-promise-reject-errors`
// enforces that — correctly. But a third-party driver is not production code we control:
// `mysql2` and `amqplib` can both reject with a bare string or a response object, which is why
// every `catch` in this module reads `err instanceof Error ? err.message : String(err)`. Those
// defensive arms are unreachable from any double that obeys the rule, so a fault injector that
// simulates a hostile driver has to step outside it.
//
// The exception is confined HERE, stated once, and routed to by every fault-injection site —
// rather than a disable comment at each of them. It is the second `eslint-disable` in the
// repository, and it should stay that rare.
// eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
export const rejectWithNonError = (value: unknown): Promise<never> => Promise.reject(value);

export class FakeLogger {
  public readonly assignments: Record<string, unknown>[] = [];
  public readonly logs: { context: unknown; message?: string }[] = [];
  // `warn` lines land in their own array so a spec can assert the missing-template /
  // dispatch-failed warn branches without disturbing the `logs` (info) ordering the
  // sibling specs assert on.
  public readonly warns: { context: unknown; message?: string }[] = [];
  public readonly debugs: { context: unknown; message?: string }[] = [];

  public assign(context: Record<string, unknown>): void {
    this.assignments.push(context);
  }

  public info(context: unknown, message?: string): void {
    this.logs.push({ context, message });
  }

  public warn(context: unknown, message?: string): void {
    this.warns.push({ context, message });
  }

  // `PinoLogger` has one and this double did not — so a use case that debug-logs its quiet path (the
  // retention sweep's "nothing aged out") crashed the spec with `logger.debug is not a function`. A
  // double that is missing a method the real thing has does not fail honestly; it fails somewhere
  // unrelated, at the first caller that reaches for it.
  public debug(context: unknown, message?: string): void {
    this.debugs.push({ context, message });
  }
}

// A persistence-simulating template repo for the authoring use-case specs: `save`
// assigns a fresh BIGINT to an id-less row (and re-`reconstitute`s it with concrete
// timestamps, the real repo's re-read idiom) or replaces the row in place by id;
// `maxVersion` / `findByNaturalKey` / `findById` / `list` / `findLatestActive` read
// the in-memory `rows`. It lets a spec author a real version chain and observe the
// retained history, rather than stubbing each method per call.
export class InMemoryTemplateRepo implements INotificationTemplateRepositoryPort {
  public readonly rows: NotificationTemplate[] = [];
  private seq = 0;

  private static matches(
    row: NotificationTemplate,
    eventType: string,
    channel: NotificationChannelEnum,
    locale: string,
  ): boolean {
    return row.eventType === eventType && row.channel === channel && row.locale === locale;
  }

  public save(template: NotificationTemplate): Promise<NotificationTemplate> {
    const id = template.id ?? ++this.seq;
    const persisted = NotificationTemplate.reconstitute({
      id,
      eventType: template.eventType,
      channel: template.channel,
      locale: template.locale,
      subject: template.subject,
      body: template.body,
      version: template.version,
      active: template.active,
      createdAt: template.createdAt ?? new Date(),
      updatedAt: new Date(),
    });
    const idx = this.rows.findIndex((r) => r.id === id);
    if (idx >= 0) {
      this.rows[idx] = persisted;
    } else {
      this.rows.push(persisted);
    }
    return Promise.resolve(persisted);
  }

  public findById(id: number): Promise<NotificationTemplate | null> {
    return Promise.resolve(this.rows.find((r) => r.id === id) ?? null);
  }

  public findLatestActive(
    eventType: string,
    channel: NotificationChannelEnum,
    locale: string,
  ): Promise<NotificationTemplate | null> {
    const candidates = this.rows
      .filter((r) => InMemoryTemplateRepo.matches(r, eventType, channel, locale) && r.active)
      .sort((a, b) => b.version - a.version);
    return Promise.resolve(candidates[0] ?? null);
  }

  public findByNaturalKey(
    eventType: string,
    channel: NotificationChannelEnum,
    locale: string,
    version: number,
  ): Promise<NotificationTemplate | null> {
    return Promise.resolve(
      this.rows.find(
        (r) => InMemoryTemplateRepo.matches(r, eventType, channel, locale) && r.version === version,
      ) ?? null,
    );
  }

  public maxVersion(
    eventType: string,
    channel: NotificationChannelEnum,
    locale: string,
  ): Promise<number | null> {
    const versions = this.rows
      .filter((r) => InMemoryTemplateRepo.matches(r, eventType, channel, locale))
      .map((r) => r.version);
    return Promise.resolve(versions.length > 0 ? Math.max(...versions) : null);
  }

  public list(filter: INotificationTemplateListFilter): Promise<NotificationTemplate[]> {
    return Promise.resolve(
      this.rows.filter(
        (r) =>
          (filter.eventType === undefined || r.eventType === filter.eventType) &&
          (filter.channel === undefined || r.channel === filter.channel) &&
          (filter.locale === undefined || r.locale === filter.locale) &&
          (filter.activeOnly !== true || r.active),
      ),
    );
  }
}

// A persistence-simulating delivery repo for the delivery read/outcome use-case specs:
// `save` assigns a fresh BIGINT to an id-less row (re-`reconstitute`d with concrete
// timestamps, the real repo's re-read idiom) or replaces the row in place by id;
// `findById` / `list` / `findByDedupeKey` / `listRetryable` read the in-memory `rows`.
// `list` applies the same optional-field filter narrowing the real repo does and pages
// over an id-DESC (newest-first) sort, so a spec can prove a filter narrows the page.
export class InMemoryDeliveryRepo implements INotificationDeliveryRepositoryPort {
  public readonly rows: NotificationDelivery[] = [];
  // Makes `save` reject, standing in for a database fault at the moment a use case persists.
  // The retry sweeper isolates each row precisely so one of these cannot abort the whole sweep.
  public failSave = false;
  // As `failSave`, but rejecting with a value that is not an `Error` — the other arm of the
  // sweep loop's defensive stringify.
  public failSaveWith: unknown = undefined;
  // Drops `failureReason` on the way back out, standing in for a `failed` row whose
  // `failure_reason` column is NULL. Unreachable through the domain (`markFailed` always sets
  // one), which is exactly why the `?? 'unknown'` default on the emitted event needs a double to
  // reach it — a defensive branch with no way in is a branch nobody has checked.
  public stripFailureReasonOnSave = false;
  private seq = 0;

  public save(delivery: NotificationDelivery): Promise<NotificationDelivery> {
    if (this.failSaveWith !== undefined) {
      return rejectWithNonError(this.failSaveWith);
    }
    if (this.failSave) {
      return Promise.reject(new Error('deadlock found when trying to get lock'));
    }
    const id = delivery.id ?? ++this.seq;
    const persisted = NotificationDelivery.reconstitute({
      id,
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
      createdAt: delivery.createdAt ?? new Date(),
      updatedAt: new Date(),
      ...(this.stripFailureReasonOnSave ? { failureReason: null } : {}),
    });
    const idx = this.rows.findIndex((r) => r.id === id);
    if (idx >= 0) {
      this.rows[idx] = persisted;
    } else {
      this.rows.push(persisted);
    }
    return Promise.resolve(persisted);
  }

  public findById(id: number): Promise<NotificationDelivery | null> {
    return Promise.resolve(this.rows.find((r) => r.id === id) ?? null);
  }

  public findByDedupeKey(
    templateId: number,
    eventReferenceType: string,
    eventReferenceId: string,
    channel: NotificationChannelEnum,
    recipientCustomerId: string,
  ): Promise<NotificationDelivery | null> {
    return Promise.resolve(
      this.rows.find(
        (r) =>
          r.templateId === templateId &&
          r.eventReferenceType === eventReferenceType &&
          r.eventReferenceId === eventReferenceId &&
          r.channel === channel &&
          r.recipientCustomerId === recipientCustomerId,
      ) ?? null,
    );
  }

  public list(
    filter: INotificationDeliveryListFilter,
    page: INotificationDeliveryPageRequest,
  ): Promise<INotificationDeliveryPage> {
    const matched = this.rows
      .filter(
        (r) =>
          (filter.status === undefined || r.status === filter.status) &&
          (filter.channel === undefined || r.channel === filter.channel) &&
          (filter.eventReferenceType === undefined ||
            r.eventReferenceType === filter.eventReferenceType) &&
          (filter.eventReferenceId === undefined ||
            r.eventReferenceId === filter.eventReferenceId) &&
          (filter.recipientCustomerId === undefined ||
            r.recipientCustomerId === filter.recipientCustomerId),
      )
      // Newest-first, id DESC as the in-memory stand-in for `created_at DESC, id DESC`.
      .sort((a, b) => (b.id ?? 0) - (a.id ?? 0));

    const start = (page.page - 1) * page.size;
    return Promise.resolve({
      items: matched.slice(start, start + page.size),
      total: matched.length,
      page: page.page,
      size: page.size,
    });
  }

  // Both arms of the real scan, and the status predicates matter: this double used to filter on
  // `attemptCount` ALONE, which quietly made every `sent` row look retryable to a sweeper spec. A
  // double that is laxer than the query it stands in for does not fail — it just stops asserting.
  //
  //  1. `failed` under the attempt budget — the ordinary recorded failure;
  //  2. `queued` older than `queuedStaleBefore` — the row orphaned between the persist and the
  //     dispatch. A null `createdAt` (a domain object that never round-tripped a mapper) is treated
  //     as NOT stale, the same conservative direction `deleteOlderThan` takes below.
  //
  // Ordered oldest-attempt-first with NULLs leading, mirroring MySQL's ASC ordering — so an orphan
  // (which has no `lastAttemptAt` at all) leads the batch, exactly as it does in production.
  public listRetryable(
    maxAttempts: number,
    limit: number,
    queuedStaleBefore: Date,
  ): Promise<NotificationDelivery[]> {
    const matched = this.rows.filter(
      (r) =>
        (r.status === NotificationDeliveryStatusEnum.FAILED && r.attemptCount < maxAttempts) ||
        (r.status === NotificationDeliveryStatusEnum.QUEUED &&
          r.createdAt !== null &&
          r.createdAt.getTime() < queuedStaleBefore.getTime()),
    );
    const ordered = [...matched].sort((a, b) => {
      const at = a.lastAttemptAt?.getTime() ?? -Infinity;
      const bt = b.lastAttemptAt?.getTime() ?? -Infinity;
      return at === bt ? (a.id ?? 0) - (b.id ?? 0) : at - bt;
    });
    return Promise.resolve(ordered.slice(0, limit));
  }

  // The retention sweep's HARD delete (ISSUE-08). It really removes the rows — a double that merely
  // flagged them would model a *soft* delete, which is the one thing this must not be: the row is the
  // dedupe anchor, and a hidden-but-present row means the same notification sends twice.
  //
  // `createdAt` is null on a domain object that never round-tripped through the mapper; such a row is
  // treated as **not yet aged**, the conservative direction (a purge that deletes what it cannot date
  // is worse than one that skips it).
  public deleteOlderThan(horizon: Date, limit: number): Promise<number> {
    const doomed = this.rows
      .filter((r) => r.createdAt !== null && r.createdAt < horizon)
      .slice(0, limit);
    for (const row of doomed) {
      this.rows.splice(this.rows.indexOf(row), 1);
    }
    return Promise.resolve(doomed.length);
  }
}
