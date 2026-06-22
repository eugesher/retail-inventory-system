import { PinoLogger } from 'nestjs-pino';

import { NotificationChannelEnum } from '@retail-inventory-system/contracts';

import { Notification } from '../../../domain';
import { LogNotifierAdapter } from '../log.notifier.adapter';

describe('LogNotifierAdapter', () => {
  let infoSpy: jest.Mock;
  let adapter: LogNotifierAdapter;

  beforeEach(() => {
    infoSpy = jest.fn();
    const fakeLogger = { info: infoSpy } as unknown as PinoLogger;
    adapter = new LogNotifierAdapter(fakeLogger);
  });

  it('emits a Pino info line containing every notification field', async () => {
    const notification = new Notification({
      recipient: 'customer:7',
      channel: NotificationChannelEnum.EMAIL,
      subject: 'Order 42 received',
      body: 'Order 42 is now pending.',
      metadata: { orderId: 42, customerId: 7 },
    });

    await adapter.send(notification);

    expect(infoSpy).toHaveBeenCalledTimes(1);
    expect(infoSpy).toHaveBeenCalledWith(
      {
        recipient: 'customer:7',
        channel: NotificationChannelEnum.EMAIL,
        subject: 'Order 42 received',
        body: 'Order 42 is now pending.',
        metadata: { orderId: 42, customerId: 7 },
      },
      'Notification dispatched',
    );
  });
});
