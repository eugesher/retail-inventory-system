import { NotificationChannelEnum } from '@retail-inventory-system/contracts';

import { NotificationDelivery, NotificationTemplate } from '../../../domain';
import {
  INotificationDeliveryListFilter,
  INotificationDeliveryPage,
  INotificationDeliveryPageRequest,
  INotificationDeliveryRepositoryPort,
  INotificationTemplateListFilter,
  INotificationTemplateRepositoryPort,
} from '../../ports';

export class FakeLogger {
  public readonly assignments: Record<string, unknown>[] = [];
  public readonly logs: { context: unknown; message?: string }[] = [];
  // `warn` lines land in their own array so a spec can assert the missing-template /
  // dispatch-failed warn branches without disturbing the `logs` (info) ordering the
  // sibling specs assert on.
  public readonly warns: { context: unknown; message?: string }[] = [];

  public assign(context: Record<string, unknown>): void {
    this.assignments.push(context);
  }

  public info(context: unknown, message?: string): void {
    this.logs.push({ context, message });
  }

  public warn(context: unknown, message?: string): void {
    this.warns.push({ context, message });
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
  private seq = 0;

  public save(delivery: NotificationDelivery): Promise<NotificationDelivery> {
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

  public listRetryable(maxAttempts: number, limit: number): Promise<NotificationDelivery[]> {
    const matched = this.rows.filter((r) => r.attemptCount < maxAttempts);
    return Promise.resolve(matched.slice(0, limit));
  }
}
