import { Inject, Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';

import {
  NotificationChannelEnum,
  NotificationDeliveryStatusEnum,
} from '@retail-inventory-system/contracts';

import { Notification, NotificationDelivery } from '../../domain';
import {
  INotificationDeliveryRepositoryPort,
  INotificationTemplateRepositoryPort,
  INotifierPort,
  ITemplateRendererPort,
  NOTIFICATION_DELIVERY_REPOSITORY,
  NOTIFICATION_TEMPLATE_REPOSITORY,
  NOTIFIER,
  TEMPLATE_RENDERER,
} from '../ports';
import { resolveTransportSubject } from './transport-subject';

// The default locale when a consumer does not supply one. Every seeded template is keyed
// at `en-US` this capability; a future localized catalogue would pass the buyer's locale
// through from the producer event (carried alongside `customerEmail`, ADR-033).
const DEFAULT_LOCALE = 'en-US';

// The channel-agnostic input the Render & Dispatch pipeline runs on. The CONSUMER owns
// the wire-event → input translation (it knows which event field is the recipient email,
// which is the reference id, what the render context should contain); the use case is
// channel- and event-agnostic, so this is the single shape every consumer maps onto when
// it is rewired onto this pipeline.
//
// - `eventType` is the template registry key's first component (e.g. a routing key like
//   `retail.order.placed`); it is also the null-subject fallback (below).
// - `channel` is the business delivery channel (EMAIL this capability).
// - `locale` defaults to `en-US`.
// - `recipientCustomerId` is null for system/ops notifications (e.g. a low-stock alert to
//   the ops mailbox) — a null recipient is NOT deduped (ADR-033).
// - `recipientAddress` is the resolved destination (a customer email or the ops mailbox).
// - `eventReferenceType` / `eventReferenceId` link the delivery back to the business
//   event (`order`/`return-request`/`stock-low`/`fulfillment`/`refund` + its id) and form
//   the dedupe scope together with the resolved template id + `channel` +
//   `recipientCustomerId` (the template id keeps distinct event types that share one
//   reference — the `retail.return.*` family on one `rmaId` — from collapsing).
// - `context` is the Handlebars render context (the event's fields).
// - `correlationId` threads the trace.
export interface IRenderAndDispatchInput {
  eventType: string;
  channel: NotificationChannelEnum;
  locale?: string;
  recipientCustomerId: string | null;
  recipientAddress: string;
  eventReferenceType: string;
  eventReferenceId: string;
  context: Record<string, unknown>;
  correlationId: string;
}

// `RenderAndDispatchUseCase` is the heart of the notification capability — the single
// pipeline every event consumer ultimately calls. Given a domain event reduced to the
// channel-agnostic `IRenderAndDispatchInput`, it resolves the latest active template,
// renders subject/body, **persists a `NotificationDelivery` row in `queued` BEFORE any
// dispatch**, calls `NOTIFIER.send`, then flips the row `→ sent` on success or `→ failed`
// (recording the reason) on a thrown NOTIFIER.
//
// The ordering is the point (ADR-033): the queued row is written first so a crash
// mid-send still leaves an auditable record the retry sweeper (a later capability) can
// pick up — the inverse order (send then record) loses the delivery silently on a crash
// after the send. A NOTIFIER failure is therefore **recorded, not rethrown** — the row
// captures the failure and the sweeper re-attempts; rethrowing would lose the audit row's
// value and (under at-least-once RMQ) trigger a blind redelivery instead.
//
// **Idempotency is two-layered.** The explicit `findByDedupeKey` pre-check (customer-
// facing rows only) collapses an event REDELIVERY (ADR-020 at-least-once) to a no-op
// before any dispatch; the database UNIQUE on the generated `delivery_dedupe_key` +
// the repository's `ER_DUP_ENTRY` translation collapses a true CONCURRENT race of two
// consumers to a single row. System/ops rows (`recipientCustomerId === null`) carry a
// null dedupe key and are intentionally not deduped.
//
// The `NOTIFIER` port stays a single method (ADR-011) — the rendered subject/body thread
// through the existing `Notification` value object; the template/delivery machinery sits
// *in front of* the transport, which stays `LogNotifierAdapter` by default.
//
// `correlationId` is logged **inline** in every branch (never via `PinoLogger.assign`,
// which throws outside request scope — ADR-011 §7).
@Injectable()
export class RenderAndDispatchUseCase {
  constructor(
    @Inject(NOTIFICATION_TEMPLATE_REPOSITORY)
    private readonly templateRepo: INotificationTemplateRepositoryPort,
    @Inject(NOTIFICATION_DELIVERY_REPOSITORY)
    private readonly deliveryRepo: INotificationDeliveryRepositoryPort,
    @Inject(TEMPLATE_RENDERER)
    private readonly renderer: ITemplateRendererPort,
    @Inject(NOTIFIER)
    private readonly notifier: INotifierPort,
    @InjectPinoLogger(RenderAndDispatchUseCase.name)
    private readonly logger: PinoLogger,
  ) {}

  // Returns the resulting delivery (sent / failed / the pre-existing duplicate), or `null`
  // when no active template resolves (nothing was persisted). The consumers ignore the
  // return — it is returned for testability and for a future caller that wants the row.
  public async execute(input: IRenderAndDispatchInput): Promise<NotificationDelivery | null> {
    const locale = input.locale ?? DEFAULT_LOCALE;

    // 1. Resolve the live template. A missing one is a seed/config gap, not a delivery —
    //    there is nothing to render, so we warn and return WITHOUT persisting a row (a
    //    `queued` row with no template would be unrenderable noise for the sweeper).
    const template = await this.templateRepo.findLatestActive(
      input.eventType,
      input.channel,
      locale,
    );
    if (template === null) {
      this.logger.warn(
        {
          correlationId: input.correlationId,
          eventType: input.eventType,
          channel: input.channel,
          locale,
        },
        'No active notification template found; skipping delivery',
      );
      return null;
    }

    // 2. Render. The subject is rendered only when the template carries one (null for
    //    sms/push) — guarding null is the use case's concern, not the renderer's
    //    (ADR-033). HTML-escaping of context data is the renderer's default ({{ }}, never
    //    a triple-stache) — the staff-authored-template security posture.
    //
    //    A render that THROWS (a malformed staff-authored Handlebars template) or yields
    //    an empty body must NOT escape this use case: it runs inside an `@EventPattern`
    //    consumer, where an exception would blind-redeliver the event under at-least-once
    //    RMQ (and `NotificationDelivery.open` itself rejects an empty body with a plain
    //    Error). Treat both as a config gap — warn and return null WITHOUT persisting a
    //    row, exactly like a missing template.
    let renderedSubject: string | null;
    let renderedBody: string;
    try {
      renderedSubject =
        template.subject !== null ? this.renderer.render(template.subject, input.context) : null;
      renderedBody = this.renderer.render(template.body, input.context);
    } catch (err) {
      this.logger.warn(
        {
          correlationId: input.correlationId,
          eventType: input.eventType,
          channel: input.channel,
          templateId: template.id,
          reason: err instanceof Error ? err.message : String(err),
        },
        'Template render failed; skipping delivery',
      );
      return null;
    }
    if (renderedBody.trim().length === 0) {
      this.logger.warn(
        {
          correlationId: input.correlationId,
          eventType: input.eventType,
          channel: input.channel,
          templateId: template.id,
        },
        'Template rendered an empty body; skipping delivery',
      );
      return null;
    }

    // 3. Idempotency pre-check — customer-facing rows only. A redelivered event whose
    //    delivery already exists short-circuits to that row with NO second NOTIFIER call.
    if (input.recipientCustomerId !== null) {
      const existing = await this.deliveryRepo.findByDedupeKey(
        template.id!,
        input.eventReferenceType,
        input.eventReferenceId,
        input.channel,
        input.recipientCustomerId,
      );
      if (existing !== null) {
        this.logger.info(
          {
            correlationId: input.correlationId,
            deliveryId: existing.id,
            eventReferenceType: input.eventReferenceType,
            eventReferenceId: input.eventReferenceId,
            channel: input.channel,
          },
          'Duplicate delivery, skipping dispatch',
        );
        return existing;
      }
    }

    // 4. Persist the `queued` row BEFORE dispatch. On a concurrent race the repository
    //    catches the dedupe `ER_DUP_ENTRY` and returns the winner's already-persisted
    //    row (the loser's insert is collapsed); we then skip dispatch and return it.
    const queued = NotificationDelivery.open({
      templateId: template.id!,
      recipientCustomerId: input.recipientCustomerId,
      recipientAddress: input.recipientAddress,
      channel: input.channel,
      eventReferenceType: input.eventReferenceType,
      eventReferenceId: input.eventReferenceId,
      renderedSubject,
      renderedBody,
      correlationId: input.correlationId,
    });
    const delivery = await this.deliveryRepo.save(queued);

    // A persisted row that is no longer `queued` is the race-loser's view of the winner's
    // row (already dispatched by the winner) — do not re-dispatch it.
    if (delivery.status !== NotificationDeliveryStatusEnum.QUEUED) {
      this.logger.info(
        {
          correlationId: input.correlationId,
          deliveryId: delivery.id,
          status: delivery.status,
        },
        'Delivery already dispatched by a concurrent handler, skipping dispatch',
      );
      return delivery;
    }

    // 5. Dispatch, then flip the row. The `Notification` value object requires a non-empty
    //    subject; for a null-subject channel (sms/push) we fall back to `eventType` so the
    //    transport always has a meaningful line (the persisted `renderedSubject` stays
    //    null — the fallback is a transport detail, not stored content).
    const subjectForTransport = resolveTransportSubject(renderedSubject, input.eventType);
    const now = new Date();
    try {
      await this.notifier.send(
        new Notification({
          recipient: input.recipientAddress,
          channel: input.channel,
          subject: subjectForTransport,
          body: renderedBody,
          metadata: {
            deliveryId: delivery.id,
            eventType: input.eventType,
            eventReferenceType: input.eventReferenceType,
            eventReferenceId: input.eventReferenceId,
            correlationId: input.correlationId,
          },
        }),
      );
      delivery.markSent(now);
      this.logger.info(
        {
          correlationId: input.correlationId,
          deliveryId: delivery.id,
          channel: input.channel,
          eventReferenceType: input.eventReferenceType,
          eventReferenceId: input.eventReferenceId,
        },
        'Notification dispatched',
      );
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      delivery.markFailed(now, reason);
      // Recorded, NOT rethrown — the row holds the failure and the retry sweeper (a later
      // capability) re-attempts. Rethrowing would discard the audit row and trigger a
      // blind RMQ redelivery instead.
      this.logger.warn(
        {
          correlationId: input.correlationId,
          deliveryId: delivery.id,
          reason,
        },
        'Notification dispatch failed; recorded for retry',
      );
    }

    return this.deliveryRepo.save(delivery);
  }
}
