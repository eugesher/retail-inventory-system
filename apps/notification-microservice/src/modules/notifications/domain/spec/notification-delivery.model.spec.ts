import {
  NotificationChannelEnum,
  NotificationDeliveryStatusEnum,
} from '@retail-inventory-system/contracts';

import {
  IOpenNotificationDeliveryInput,
  NotificationDelivery,
  NotificationDomainException,
  NotificationErrorCodeEnum,
} from '..';

const openInput = (
  overrides: Partial<IOpenNotificationDeliveryInput> = {},
): IOpenNotificationDeliveryInput => ({
  templateId: 1,
  recipientCustomerId: '11111111-1111-4111-8111-111111111111',
  recipientAddress: 'buyer@example.com',
  channel: NotificationChannelEnum.EMAIL,
  eventReferenceType: 'order',
  eventReferenceId: '42',
  renderedSubject: 'Your order ORD-2026-00000042 is confirmed',
  renderedBody: 'Hi, thanks for your order.',
  correlationId: 'corr-abc',
  ...overrides,
});

const at = (iso: string): Date => new Date(iso);

describe('NotificationDelivery', () => {
  describe('open factory', () => {
    it('opens a queued delivery with attemptCount 0 and a null lastAttemptAt', () => {
      const delivery = NotificationDelivery.open(openInput());

      expect(delivery.id).toBeNull();
      expect(delivery.status).toBe(NotificationDeliveryStatusEnum.QUEUED);
      expect(delivery.attemptCount).toBe(0);
      expect(delivery.lastAttemptAt).toBeNull();
      expect(delivery.failureReason).toBeNull();
      expect(delivery.templateId).toBe(1);
      expect(delivery.recipientCustomerId).toBe('11111111-1111-4111-8111-111111111111');
      expect(delivery.recipientAddress).toBe('buyer@example.com');
      expect(delivery.eventReferenceType).toBe('order');
      expect(delivery.eventReferenceId).toBe('42');
    });

    it('allows a null recipientCustomerId (system/ops notifications)', () => {
      const delivery = NotificationDelivery.open(
        openInput({ recipientCustomerId: null, recipientAddress: 'ops@example.com' }),
      );
      expect(delivery.recipientCustomerId).toBeNull();
    });

    it('rejects an empty recipientAddress with the typed DELIVERY_RECIPIENT_REQUIRED', () => {
      expect(() => NotificationDelivery.open(openInput({ recipientAddress: '  ' }))).toThrow(
        NotificationDomainException,
      );
      try {
        NotificationDelivery.open(openInput({ recipientAddress: '' }));
      } catch (err) {
        expect((err as NotificationDomainException).code).toBe(
          NotificationErrorCodeEnum.DELIVERY_RECIPIENT_REQUIRED,
        );
      }
    });

    it('rejects an empty renderedBody (internal-caller bug → plain Error)', () => {
      expect(() => NotificationDelivery.open(openInput({ renderedBody: '' }))).toThrow(Error);
    });

    it('rejects a non-positive templateId (internal-caller bug → plain Error)', () => {
      expect(() => NotificationDelivery.open(openInput({ templateId: 0 }))).toThrow(Error);
    });
  });

  describe('legal status transitions', () => {
    it('markSent: queued → sent, increments attemptCount, stamps lastAttemptAt', () => {
      const delivery = NotificationDelivery.open(openInput());
      const t = at('2026-06-21T10:00:00Z');

      delivery.markSent(t);

      expect(delivery.status).toBe(NotificationDeliveryStatusEnum.SENT);
      expect(delivery.attemptCount).toBe(1);
      expect(delivery.lastAttemptAt).toEqual(t);
    });

    it('markFailed: queued → failed, increments attemptCount, records the reason', () => {
      const delivery = NotificationDelivery.open(openInput());
      const t = at('2026-06-21T10:00:00Z');

      delivery.markFailed(t, 'smtp timeout');

      expect(delivery.status).toBe(NotificationDeliveryStatusEnum.FAILED);
      expect(delivery.attemptCount).toBe(1);
      expect(delivery.lastAttemptAt).toEqual(t);
      expect(delivery.failureReason).toBe('smtp timeout');
    });

    it('markDelivered: sent → delivered, no attempt counted', () => {
      const delivery = NotificationDelivery.open(openInput());
      delivery.markSent(at('2026-06-21T10:00:00Z'));

      delivery.markDelivered();

      expect(delivery.status).toBe(NotificationDeliveryStatusEnum.DELIVERED);
      expect(delivery.attemptCount).toBe(1);
    });

    it('markBounced: sent → bounced, records the reason, no attempt counted', () => {
      const delivery = NotificationDelivery.open(openInput());
      delivery.markSent(at('2026-06-21T10:00:00Z'));

      delivery.markBounced('mailbox full');

      expect(delivery.status).toBe(NotificationDeliveryStatusEnum.BOUNCED);
      expect(delivery.failureReason).toBe('mailbox full');
      expect(delivery.attemptCount).toBe(1);
    });

    it('markSent clears a prior failureReason (the attempt succeeded)', () => {
      const delivery = NotificationDelivery.open(openInput());
      delivery.markFailed(at('2026-06-21T10:00:00Z'), 'smtp timeout');

      delivery.markSent(at('2026-06-21T10:05:00Z'));

      expect(delivery.status).toBe(NotificationDeliveryStatusEnum.SENT);
      expect(delivery.failureReason).toBeNull();
    });
  });

  describe('illegal status transitions (typed code)', () => {
    it('rejects markDelivered from queued (must be sent first)', () => {
      const delivery = NotificationDelivery.open(openInput());

      try {
        delivery.markDelivered();
        fail('expected markDelivered to throw');
      } catch (err) {
        expect(err).toBeInstanceOf(NotificationDomainException);
        expect((err as NotificationDomainException).code).toBe(
          NotificationErrorCodeEnum.DELIVERY_INVALID_STATUS_TRANSITION,
        );
      }
      // A rejected transition leaves the delivery untouched.
      expect(delivery.status).toBe(NotificationDeliveryStatusEnum.QUEUED);
    });

    it('rejects markBounced from queued', () => {
      const delivery = NotificationDelivery.open(openInput());
      expect(() => delivery.markBounced('x')).toThrow(NotificationDomainException);
    });

    it('rejects markSent from a terminal delivered state', () => {
      const delivery = NotificationDelivery.open(openInput());
      delivery.markSent(at('2026-06-21T10:00:00Z'));
      delivery.markDelivered();

      try {
        delivery.markSent(at('2026-06-21T11:00:00Z'));
        fail('expected markSent to throw');
      } catch (err) {
        expect((err as NotificationDomainException).code).toBe(
          NotificationErrorCodeEnum.DELIVERY_INVALID_STATUS_TRANSITION,
        );
      }
    });

    it('rejects markFailed from a terminal bounced state', () => {
      const delivery = NotificationDelivery.open(openInput());
      delivery.markSent(at('2026-06-21T10:00:00Z'));
      delivery.markBounced('mailbox full');

      expect(() => delivery.markFailed(at('2026-06-21T11:00:00Z'), 'x')).toThrow(
        NotificationDomainException,
      );
    });
  });

  describe('attemptCount monotonicity', () => {
    it('climbs across markFailed then a retrying markSent, never decreasing', () => {
      const delivery = NotificationDelivery.open(openInput());
      expect(delivery.attemptCount).toBe(0);

      delivery.markFailed(at('2026-06-21T10:00:00Z'), 'smtp timeout');
      expect(delivery.attemptCount).toBe(1);

      // failed → sent is the retry-succeeds path; the count keeps climbing.
      delivery.markSent(at('2026-06-21T10:05:00Z'));
      expect(delivery.attemptCount).toBe(2);
    });

    it('climbs across two consecutive failures (failed → failed retries)', () => {
      const delivery = NotificationDelivery.open(openInput());

      delivery.markFailed(at('2026-06-21T10:00:00Z'), 'first');
      delivery.markFailed(at('2026-06-21T10:05:00Z'), 'second');

      expect(delivery.attemptCount).toBe(2);
      expect(delivery.status).toBe(NotificationDeliveryStatusEnum.FAILED);
      expect(delivery.failureReason).toBe('second');
    });
  });

  describe('reconstitute', () => {
    it('rebuilds a persisted failed delivery and can still retry to sent', () => {
      const delivery = NotificationDelivery.reconstitute({
        id: 5,
        templateId: 1,
        recipientCustomerId: null,
        recipientAddress: 'ops@example.com',
        channel: NotificationChannelEnum.EMAIL,
        eventReferenceType: 'stock-low',
        eventReferenceId: '7',
        status: NotificationDeliveryStatusEnum.FAILED,
        attemptCount: 1,
        lastAttemptAt: at('2026-06-21T09:00:00Z'),
        failureReason: 'smtp timeout',
        renderedSubject: 'Low stock',
        renderedBody: 'Variant 7 is low.',
        correlationId: 'corr-xyz',
      });

      expect(delivery.id).toBe(5);
      expect(delivery.status).toBe(NotificationDeliveryStatusEnum.FAILED);

      delivery.markSent(at('2026-06-21T10:00:00Z'));
      expect(delivery.status).toBe(NotificationDeliveryStatusEnum.SENT);
      expect(delivery.attemptCount).toBe(2);
    });
  });
});
