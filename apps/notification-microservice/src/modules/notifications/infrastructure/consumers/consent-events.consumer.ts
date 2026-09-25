import { Controller, Inject } from '@nestjs/common';
import { EventPattern, Payload } from '@nestjs/microservices';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';

import {
  ICustomerConsentUpdatedEvent,
  ICustomerErasedEvent,
} from '@retail-inventory-system/contracts';
import { ROUTING_KEYS } from '@retail-inventory-system/messaging';

import { CONSENT_CACHE, IConsentCachePort } from '../../application/ports';

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
