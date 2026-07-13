import { ClientProxy } from '@nestjs/microservices';
import { PinoLogger } from 'nestjs-pino';
import { of, throwError } from 'rxjs';

import {
  ICustomerConsentUpdatedEvent,
  ICustomerErasedEvent,
} from '@retail-inventory-system/contracts';
import { RisEventsMirrorPublisher, ROUTING_KEYS } from '@retail-inventory-system/messaging';

import { ConsentRecord } from '../../../domain';
import { CustomerEventsRabbitmqPublisher } from '../customer-events.rabbitmq.publisher';

describe('CustomerEventsRabbitmqPublisher', () => {
  let publisher: CustomerEventsRabbitmqPublisher;
  let notificationClient: jest.Mocked<Pick<ClientProxy, 'emit'>>;
  let risEvents: jest.Mocked<Pick<RisEventsMirrorPublisher, 'mirror'>>;
  let logger: jest.Mocked<Pick<PinoLogger, 'warn'>>;

  beforeEach(() => {
    notificationClient = { emit: jest.fn().mockReturnValue(of(undefined)) };
    risEvents = { mirror: jest.fn().mockResolvedValue(undefined) };
    logger = { warn: jest.fn() };

    publisher = new CustomerEventsRabbitmqPublisher(
      notificationClient as unknown as ClientProxy,
      risEvents as unknown as RisEventsMirrorPublisher,
      logger as unknown as PinoLogger,
    );
  });

  describe('publishConsentUpdated', () => {
    const record = ConsentRecord.rehydrate('cust-1', {
      transactionalEmail: true,
      marketingEmail: true,
      marketingSms: false,
      dataRetentionPolicy: 'default-7-years',
      updatedAt: new Date('2026-07-04T10:00:00.000Z'),
    });

    it('emits onto notification_events AND mirrors onto ris.events with the full snapshot', async () => {
      await publisher.publishConsentUpdated({ record, correlationId: 'corr-1' });

      expect(notificationClient.emit).toHaveBeenCalledTimes(1);
      const [primaryKey, primaryEvent] = notificationClient.emit.mock.calls[0] as [
        string,
        ICustomerConsentUpdatedEvent,
      ];
      expect(primaryKey).toBe(ROUTING_KEYS.CUSTOMER_CONSENT_UPDATED);
      expect(primaryEvent).toMatchObject({
        customerId: 'cust-1',
        transactionalEmail: true,
        marketingEmail: true,
        marketingSms: false,
        dataRetentionPolicy: 'default-7-years',
        updatedAt: '2026-07-04T10:00:00.000Z',
        correlationId: 'corr-1',
        eventVersion: 'v1',
      });
      expect(typeof primaryEvent.occurredAt).toBe('string');

      // The mirror fires with the SAME routing key + payload, ordered after the primary.
      expect(risEvents.mirror).toHaveBeenCalledTimes(1);
      expect(risEvents.mirror).toHaveBeenCalledWith(
        ROUTING_KEYS.CUSTOMER_CONSENT_UPDATED,
        primaryEvent,
      );
    });

    it('swallows a rejected primary emit (best-effort) and still mirrors', async () => {
      notificationClient.emit.mockReturnValueOnce(throwError(() => new Error('broker down')));

      await expect(
        publisher.publishConsentUpdated({ record, correlationId: 'corr-1' }),
      ).resolves.toBeUndefined();

      // The committed write is never blocked: the failure is warn-logged, not rethrown.
      expect(logger.warn).toHaveBeenCalledTimes(1);
      // The mirror still fires — a primary hiccup does not skip the firehose.
      expect(risEvents.mirror).toHaveBeenCalledTimes(1);
    });
  });

  describe('publishErased', () => {
    it('emits + mirrors customer.erased carrying NO PII', async () => {
      const erasedAt = new Date('2026-07-04T12:00:00.000Z');
      await publisher.publishErased({
        customerId: 'cust-2',
        erasedAt,
        actorStaffUserId: 'staff-9',
        correlationId: 'corr-2',
      });

      expect(notificationClient.emit).toHaveBeenCalledTimes(1);
      const [primaryKey, primaryEvent] = notificationClient.emit.mock.calls[0] as [
        string,
        ICustomerErasedEvent,
      ];
      expect(primaryKey).toBe(ROUTING_KEYS.CUSTOMER_ERASED);
      expect(primaryEvent).toMatchObject({
        customerId: 'cust-2',
        erasedAt: '2026-07-04T12:00:00.000Z',
        actorStaffUserId: 'staff-9',
        correlationId: 'corr-2',
        eventVersion: 'v1',
      });
      expect(typeof primaryEvent.occurredAt).toBe('string');
      // Guard the no-PII rule explicitly: no email/name/phone keys on the wire.
      expect(Object.keys(primaryEvent).sort()).toEqual(
        [
          'actorStaffUserId',
          'correlationId',
          'customerId',
          'erasedAt',
          'eventVersion',
          'occurredAt',
        ].sort(),
      );

      expect(risEvents.mirror).toHaveBeenCalledWith(ROUTING_KEYS.CUSTOMER_ERASED, primaryEvent);
    });
  });
});
