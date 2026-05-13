import { Notification, NotificationChannelEnum } from '..';

describe('Notification', () => {
  const validProps = {
    recipient: 'customer:7',
    channel: NotificationChannelEnum.LOG,
    subject: 'Order 1 received',
    body: 'Order body',
    metadata: { orderId: 1 },
  };

  it('constructs with valid props', () => {
    const notification = new Notification(validProps);
    expect(notification.recipient).toBe('customer:7');
    expect(notification.channel).toBe(NotificationChannelEnum.LOG);
    expect(notification.subject).toBe('Order 1 received');
    expect(notification.body).toBe('Order body');
    expect(notification.metadata).toEqual({ orderId: 1 });
  });

  it('rejects empty recipient', () => {
    expect(() => new Notification({ ...validProps, recipient: '' })).toThrow(/recipient/);
    expect(() => new Notification({ ...validProps, recipient: '   ' })).toThrow(/recipient/);
  });

  it('rejects empty subject and body', () => {
    expect(() => new Notification({ ...validProps, subject: '' })).toThrow(/subject/);
    expect(() => new Notification({ ...validProps, body: '' })).toThrow(/body/);
  });

  it('rejects an unknown channel', () => {
    expect(
      () =>
        new Notification({
          ...validProps,
          channel: 'sms' as NotificationChannelEnum,
        }),
    ).toThrow(/unknown channel/);
  });

  it('compares by value (ValueObject equality)', () => {
    const a = new Notification(validProps);
    const b = new Notification(validProps);
    expect(a.equals(b)).toBe(true);
  });
});
