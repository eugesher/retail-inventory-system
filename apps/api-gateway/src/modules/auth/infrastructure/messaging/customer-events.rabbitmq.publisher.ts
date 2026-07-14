import { Inject, Injectable } from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';

import {
  ICustomerConsentUpdatedEvent,
  ICustomerErasedEvent,
  MicroserviceClientTokenEnum,
} from '@retail-inventory-system/contracts';
import {
  emitBestEffort,
  RisEventsMirrorPublisher,
  ROUTING_KEYS,
} from '@retail-inventory-system/messaging';

import {
  IConsentUpdatedPublishInput,
  ICustomerEventsPublisherPort,
  ICustomerErasedPublishInput,
} from '../../application/ports';

// The `auth` module's `CUSTOMER_EVENTS_PUBLISHER` binding and its sole
// `ClientProxy` holder (ADR-009). It publishes the two `customer.*` privacy events
// to BOTH destinations the capability needs:
//
//   1. The **primary** emit onto `notification_events` (the `NOTIFICATION_MICROSERVICE`
//      client) — the producer-targets-consumer-queue pattern (ADR-008/020). This is
//      what the notification consent consumers bind to.
//   2. The **mirror** onto the `ris.events` topic exchange, via the shared
//      `RisEventsMirrorPublisher` (ADR-035), so the event-store firehose captures the
//      stream without any consumer being re-bound.
//
// Both are **best-effort post-commit** (ADR-020): the consent record / tombstone has
// already committed, so a broker hiccup must never surface to the caller. Both legs
// route through the shared `emitBestEffort` helper (warn-log + swallow + timeout). The
// mirror is ordered **after** the primary emit so a mirror hiccup can never shadow the
// publish that feeds the real consumers.
@Injectable()
export class CustomerEventsRabbitmqPublisher implements ICustomerEventsPublisherPort {
  constructor(
    @Inject(MicroserviceClientTokenEnum.NOTIFICATION_MICROSERVICE)
    private readonly notificationClient: ClientProxy,
    private readonly risEvents: RisEventsMirrorPublisher,
    @InjectPinoLogger(CustomerEventsRabbitmqPublisher.name)
    private readonly logger: PinoLogger,
  ) {}

  public async publishConsentUpdated(input: IConsentUpdatedPublishInput): Promise<void> {
    const view = input.record.toView();
    const occurredAt = new Date().toISOString();
    const event: ICustomerConsentUpdatedEvent = {
      customerId: view.customerId,
      transactionalEmail: view.transactionalEmail,
      marketingEmail: view.marketingEmail,
      marketingSms: view.marketingSms,
      dataRetentionPolicy: view.dataRetentionPolicy,
      // A just-saved record always carries a DB-stamped `updatedAt`; fall back to
      // the emit instant only for the theoretical unsaved case.
      updatedAt: view.updatedAt ?? occurredAt,
      correlationId: input.correlationId,
      eventVersion: 'v1',
      occurredAt,
    };

    await this.emitPrimary(ROUTING_KEYS.CUSTOMER_CONSENT_UPDATED, event);
    await this.risEvents.mirror(ROUTING_KEYS.CUSTOMER_CONSENT_UPDATED, event);
  }

  public async publishErased(input: ICustomerErasedPublishInput): Promise<void> {
    const occurredAt = new Date().toISOString();
    // No PII on the wire — only ids + the erase instant (ADR-037).
    const event: ICustomerErasedEvent = {
      customerId: input.customerId,
      erasedAt: input.erasedAt.toISOString(),
      actorStaffUserId: input.actorStaffUserId,
      correlationId: input.correlationId,
      eventVersion: 'v1',
      occurredAt,
    };

    await this.emitPrimary(ROUTING_KEYS.CUSTOMER_ERASED, event);
    await this.risEvents.mirror(ROUTING_KEYS.CUSTOMER_ERASED, event);
  }

  // The best-effort primary emit onto `notification_events`, via the shared
  // `emitBestEffort` helper (the same bounded-emit + warn-and-swallow the `ris.events`
  // mirror uses) — the committed consent write / tombstone is never blocked by the
  // fan-out, and a dropped event stays recoverable from the warn line's payload.
  private async emitPrimary(
    routingKey: string,
    event: ICustomerConsentUpdatedEvent | ICustomerErasedEvent,
  ): Promise<void> {
    await emitBestEffort(
      this.notificationClient,
      routingKey,
      event,
      this.logger,
      'Failed to emit customer event onto notification_events',
    );
  }
}
