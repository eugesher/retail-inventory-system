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
