import { Controller, Inject } from '@nestjs/common';
import { EventPattern, Payload } from '@nestjs/microservices';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';

import {
  ICustomerConsentUpdatedEvent,
  ICustomerErasedEvent,
} from '@retail-inventory-system/contracts';
import { ROUTING_KEYS } from '@retail-inventory-system/messaging';

import { CONSENT_CACHE, IConsentCachePort } from '../../application/ports';

// Keeps the notification consent cache fresh from the api-gateway `auth` module's
// `customer.*` privacy events (ADR-037), both riding `notification_events`:
//
//  - `customer.consent.updated` carries the FULL consent snapshot, so this consumer
//    write-throughs it into the cache directly — NO database read. A consent change a
//    customer just made is reflected on their very next dispatch, without waiting for
//    the TTL to expire and reload.
//  - `customer.erased` carries no PII (only the customer id) — this consumer evicts the
//    cached entry, so a subsequent dispatch re-loads the absent-row defaults (marketing
//    denied) and the consent-gate short-circuits an erased customer's marketing sends.
//
// Both handlers log `correlationId` **inline** (never `PinoLogger.assign`, which throws
// outside request scope — ADR-011 §7) and **never rethrow**: an exception out of an
// `@EventPattern` blind-redelivers the message under at-least-once RMQ (ADR-020). The
// `CONSENT_CACHE` methods already swallow their own errors, so the belt-and-suspenders
// try/catch here only guards a truly unexpected throw.
@Controller()
export class ConsentEventsConsumer {
  constructor(
    @Inject(CONSENT_CACHE)
    private readonly consentCache: IConsentCachePort,
    @InjectPinoLogger(ConsentEventsConsumer.name)
    private readonly logger: PinoLogger,
  ) {}

  @EventPattern(ROUTING_KEYS.CUSTOMER_CONSENT_UPDATED)
  public async onConsentUpdated(@Payload() event: ICustomerConsentUpdatedEvent): Promise<void> {
    try {
      await this.consentCache.set(event.customerId, {
        transactionalEmail: event.transactionalEmail,
        marketingEmail: event.marketingEmail,
        marketingSms: event.marketingSms,
        dataRetentionPolicy: event.dataRetentionPolicy,
      });
      this.logger.info(
        { correlationId: event.correlationId, customerId: event.customerId },
        'Consent cache refreshed from customer.consent.updated',
      );
    } catch (err) {
      this.logger.warn(
        {
          err: err as Error,
          correlationId: event.correlationId,
          customerId: event.customerId,
        },
        'Failed to refresh consent cache; not rethrowing',
      );
    }
  }

  @EventPattern(ROUTING_KEYS.CUSTOMER_ERASED)
  public async onCustomerErased(@Payload() event: ICustomerErasedEvent): Promise<void> {
    try {
      await this.consentCache.del(event.customerId);
      this.logger.info(
        { correlationId: event.correlationId, customerId: event.customerId },
        'Consent cache evicted for erased customer',
      );
    } catch (err) {
      this.logger.warn(
        {
          err: err as Error,
          correlationId: event.correlationId,
          customerId: event.customerId,
        },
        'Failed to evict consent cache for erased customer; not rethrowing',
      );
    }
  }
}
