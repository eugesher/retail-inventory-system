import { NotificationChannelEnum } from '@retail-inventory-system/contracts';

import {
  ICreateNotificationTemplateInput,
  NotificationDomainException,
  NotificationErrorCodeEnum,
  NotificationTemplate,
} from '..';

const createInput = (
  overrides: Partial<ICreateNotificationTemplateInput> = {},
): ICreateNotificationTemplateInput => ({
  eventType: 'retail.order.placed',
  channel: NotificationChannelEnum.EMAIL,
  locale: 'en-US',
  subject: 'Your order {{orderNumber}} is confirmed',
  body: 'Hi {{customerName}}, thanks for your order.',
  version: 1,
  ...overrides,
});

// Asserts a `NotificationTemplate.create` call throws the expected typed code.
const expectCreateCode = (
  input: ICreateNotificationTemplateInput,
  code: NotificationErrorCodeEnum,
): void => {
  expect(() => NotificationTemplate.create(input)).toThrow(NotificationDomainException);
  try {
    NotificationTemplate.create(input);
  } catch (err) {
    expect((err as NotificationDomainException).code).toBe(code);
  }
};

describe('NotificationTemplate', () => {
  describe('create factory', () => {
    it('opens an active template at the supplied version with the authored content', () => {
      const template = NotificationTemplate.create(createInput({ version: 3 }));

      expect(template.id).toBeNull();
      expect(template.eventType).toBe('retail.order.placed');
      expect(template.channel).toBe(NotificationChannelEnum.EMAIL);
      expect(template.locale).toBe('en-US');
      expect(template.subject).toBe('Your order {{orderNumber}} is confirmed');
      expect(template.body).toBe('Hi {{customerName}}, thanks for your order.');
      expect(template.version).toBe(3);
      expect(template.active).toBe(true);
    });

    it('rejects an empty body with TEMPLATE_BODY_REQUIRED', () => {
      expectCreateCode(
        createInput({ body: '   ' }),
        NotificationErrorCodeEnum.TEMPLATE_BODY_REQUIRED,
      );
    });

    it('rejects an empty eventType with TEMPLATE_EVENT_TYPE_REQUIRED', () => {
      expectCreateCode(
        createInput({ eventType: '' }),
        NotificationErrorCodeEnum.TEMPLATE_EVENT_TYPE_REQUIRED,
      );
    });

    it('rejects an empty locale with TEMPLATE_LOCALE_REQUIRED', () => {
      expectCreateCode(
        createInput({ locale: '' }),
        NotificationErrorCodeEnum.TEMPLATE_LOCALE_REQUIRED,
      );
    });
  });

  describe('the channel-specific subject rule', () => {
    it('requires a subject for the email channel', () => {
      expectCreateCode(
        createInput({ channel: NotificationChannelEnum.EMAIL, subject: null }),
        NotificationErrorCodeEnum.TEMPLATE_SUBJECT_REQUIRED,
      );
    });

    it('requires a subject for the webhook channel', () => {
      expectCreateCode(
        createInput({ channel: NotificationChannelEnum.WEBHOOK, subject: '  ' }),
        NotificationErrorCodeEnum.TEMPLATE_SUBJECT_REQUIRED,
      );
    });

    it('allows a null subject for the sms channel (normalized to null)', () => {
      const template = NotificationTemplate.create(
        createInput({ channel: NotificationChannelEnum.SMS, subject: null }),
      );
      expect(template.subject).toBeNull();
    });

    it('allows a null subject for the push channel', () => {
      const template = NotificationTemplate.create(
        createInput({ channel: NotificationChannelEnum.PUSH, subject: null }),
      );
      expect(template.subject).toBeNull();
    });
  });

  describe('the positive-integer version rule', () => {
    it('rejects version 0', () => {
      expectCreateCode(
        createInput({ version: 0 }),
        NotificationErrorCodeEnum.TEMPLATE_VERSION_INVALID,
      );
    });

    it('rejects a negative version', () => {
      expectCreateCode(
        createInput({ version: -1 }),
        NotificationErrorCodeEnum.TEMPLATE_VERSION_INVALID,
      );
    });

    it('rejects a non-integer version', () => {
      expectCreateCode(
        createInput({ version: 1.5 }),
        NotificationErrorCodeEnum.TEMPLATE_VERSION_INVALID,
      );
    });
  });

  describe('withNextVersion (edit bumps version)', () => {
    it('derives a fresh active row at version + 1 for the same registry key', () => {
      const v1 = NotificationTemplate.create(createInput({ version: 1 }));

      const v2 = v1.withNextVersion({
        subject: 'Updated subject',
        body: 'Updated body copy.',
      });

      expect(v2.version).toBe(2);
      expect(v2.active).toBe(true);
      expect(v2.id).toBeNull();
      // Same registry key — only subject/body and the version changed.
      expect(v2.eventType).toBe(v1.eventType);
      expect(v2.channel).toBe(v1.channel);
      expect(v2.locale).toBe(v1.locale);
      expect(v2.subject).toBe('Updated subject');
      expect(v2.body).toBe('Updated body copy.');
    });

    it('leaves the prior version untouched (history is retained)', () => {
      const v1 = NotificationTemplate.create(createInput({ version: 1 }));
      v1.withNextVersion({ subject: 'Updated', body: 'Updated body.' });

      expect(v1.version).toBe(1);
      expect(v1.subject).toBe('Your order {{orderNumber}} is confirmed');
    });

    it('re-runs the channel-specific subject rule (an email edit cannot drop its subject)', () => {
      const v1 = NotificationTemplate.create(
        createInput({ channel: NotificationChannelEnum.EMAIL, version: 1 }),
      );

      expect(() => v1.withNextVersion({ subject: null, body: 'No subject.' })).toThrow(
        NotificationDomainException,
      );
    });
  });

  describe('activate / deactivate', () => {
    it('deactivate flips active to false and is idempotent', () => {
      const template = NotificationTemplate.create(createInput());

      template.deactivate();
      expect(template.active).toBe(false);
      template.deactivate();
      expect(template.active).toBe(false);
    });

    it('activate flips active back to true and is idempotent', () => {
      const template = NotificationTemplate.create(createInput());
      template.deactivate();

      template.activate();
      expect(template.active).toBe(true);
      template.activate();
      expect(template.active).toBe(true);
    });
  });

  describe('reconstitute', () => {
    it('rebuilds a persisted (inactive, higher-version) template without re-validating', () => {
      const template = NotificationTemplate.reconstitute({
        id: 9,
        eventType: 'retail.order.placed',
        channel: NotificationChannelEnum.SMS,
        locale: 'en-US',
        subject: null,
        body: 'Order {{orderNumber}} placed.',
        version: 4,
        active: false,
      });

      expect(template.id).toBe(9);
      expect(template.version).toBe(4);
      expect(template.active).toBe(false);
      expect(template.subject).toBeNull();
    });
  });
});
