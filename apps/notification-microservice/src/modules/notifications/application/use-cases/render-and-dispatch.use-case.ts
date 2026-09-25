import { Inject, Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';

import {
  NotificationChannelEnum,
  NotificationDeliveryStatusEnum,
} from '@retail-inventory-system/contracts';

import { Notification, NotificationDelivery } from '../../domain';
import {
  CONSENT_CACHE,
  IConsentCachePort,
  IConsentSnapshot,
  INotificationDeliveryRepositoryPort,
  INotificationTemplateRepositoryPort,
  INotifierPort,
  ITemplateRendererPort,
  NOTIFICATION_DELIVERY_REPOSITORY,
  NOTIFICATION_TEMPLATE_REPOSITORY,
  NOTIFIER,
  TEMPLATE_RENDERER,
} from '../ports';
import { TRANSACTIONAL_EVENT_TYPES } from './transactional-event-types';
import { resolveTransportSubject } from './transport-subject';

const DEFAULT_LOCALE = 'en-US';

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
    @Inject(CONSENT_CACHE)
    private readonly consentCache: IConsentCachePort,
    @InjectPinoLogger(RenderAndDispatchUseCase.name)
    private readonly logger: PinoLogger,
  ) {}

  public async execute(input: IRenderAndDispatchInput): Promise<NotificationDelivery | null> {
    const locale = input.locale ?? DEFAULT_LOCALE;

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

      const consent = await this.consentCache.get(input.recipientCustomerId);
      if (!this.isChannelConsented(input.channel, input.eventType, consent)) {
        const skipped = NotificationDelivery.skipped({
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
        const persisted = await this.deliveryRepo.save(skipped);
        this.logger.info(
          {
            correlationId: input.correlationId,
            deliveryId: persisted.id,
            eventType: input.eventType,
            channel: input.channel,
            recipientCustomerId: input.recipientCustomerId,
          },
          'Recipient has not consented to this channel; recorded skipped-no-consent, no dispatch',
        );
        return persisted;
      }
    }

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

  private isChannelConsented(
    channel: NotificationChannelEnum,
    eventType: string,
    consent: IConsentSnapshot,
  ): boolean {
    if (channel === NotificationChannelEnum.EMAIL) {
      return TRANSACTIONAL_EVENT_TYPES.has(eventType)
        ? consent.transactionalEmail
        : consent.marketingEmail;
    }
    if (channel === NotificationChannelEnum.SMS) {
      return consent.marketingSms;
    }
    return true;
  }
}
