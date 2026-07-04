import { Inject, Injectable } from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { firstValueFrom, timeout } from 'rxjs';

import {
  ICustomerConsentUpdatedEvent,
  ICustomerErasedEvent,
  MicroserviceClientTokenEnum,
} from '@retail-inventory-system/contracts';
import { RisEventsMirrorPublisher, ROUTING_KEYS } from '@retail-inventory-system/messaging';

import {
  IConsentUpdatedPublishInput,
  ICustomerEventsPublisherPort,
  ICustomerErasedPublishInput,
} from '../../application/ports';

// A down broker does NOT reject `emit()` — amqp-connection-manager buffers the
// publish and the returned Observable stays *pending*, which a `try/catch` can't
// catch. So the primary emit is bounded by an rxjs `timeout`: past this window it
// rejects (and is swallowed) instead of hanging the committed consent write. The
// bound is generous — a healthy broker acks in milliseconds, so it only bites
// during an outage (the `RisEventsMirrorPublisher` rationale).
const CUSTOMER_EVENT_EMIT_TIMEOUT_MS = 5_000;

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
// already committed, so a broker hiccup must never surface to the caller. The primary
// emit is wrapped here (warn-log + swallow + timeout); the mirror already owns that
// posture internally. The mirror is ordered **after** the primary emit so a mirror
// hiccup can never shadow the publish that feeds the real consumers.
@Injectable()
export class RmqCustomerEventsPublisher implements ICustomerEventsPublisherPort {
  constructor(
    @Inject(MicroserviceClientTokenEnum.NOTIFICATION_MICROSERVICE)
    private readonly notificationClient: ClientProxy,
    private readonly risEvents: RisEventsMirrorPublisher,
    @InjectPinoLogger(RmqCustomerEventsPublisher.name)
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

  // The best-effort primary emit onto `notification_events`. `ClientProxy.emit()` is
  // a cold Observable; `firstValueFrom` materializes it and waits for the broker ack,
  // bounded by the timeout. A rejected/timed-out emit is warn-logged (with the full
  // payload, so a dropped event stays recoverable) and swallowed — the committed
  // consent write is never blocked by the fan-out.
  private async emitPrimary(
    routingKey: string,
    event: ICustomerConsentUpdatedEvent | ICustomerErasedEvent,
  ): Promise<void> {
    try {
      await firstValueFrom(
        this.notificationClient
          .emit<void, ICustomerConsentUpdatedEvent | ICustomerErasedEvent>(routingKey, event)
          .pipe(timeout({ each: CUSTOMER_EVENT_EMIT_TIMEOUT_MS })),
      );
    } catch (error) {
      this.logger.warn(
        { routingKey, correlationId: event.correlationId, payload: event, err: error as Error },
        'Failed to emit customer event onto notification_events',
      );
    }
  }
}
