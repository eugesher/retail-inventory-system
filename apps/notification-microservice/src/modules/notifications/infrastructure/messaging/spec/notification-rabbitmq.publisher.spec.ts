import { ClientProxy } from '@nestjs/microservices';
import { PinoLogger } from 'nestjs-pino';
import { of, throwError } from 'rxjs';

import { INotificationDeliveryFailedEvent } from '@retail-inventory-system/contracts';
import { RisEventsMirrorPublisher, ROUTING_KEYS } from '@retail-inventory-system/messaging';
import { makePinoLoggerMock } from '@retail-inventory-system/observability/testing';

import { NotificationRabbitmqPublisher } from '../notification-rabbitmq.publisher';

// Proves the notification publisher dual-publishes (ADR-035): the reserved
// `notifications.delivery.failed` event keeps its primary `notification_events`
// emit AND mirrors the same routing key + wire onto `ris.events`.
describe('NotificationRabbitmqPublisher dual-publish', () => {
  let notificationEmit: jest.Mock;
  let mirrorEmit: jest.Mock;
  let mirror: RisEventsMirrorPublisher;
  let mirrorSpy: jest.SpyInstance;
  let publisher: NotificationRabbitmqPublisher;

  const failed = { correlationId: 'cid' } as unknown as INotificationDeliveryFailedEvent;

  beforeEach(() => {
    notificationEmit = jest.fn().mockReturnValue(of(undefined));
    mirrorEmit = jest.fn().mockReturnValue(of(undefined));
    mirror = new RisEventsMirrorPublisher(
      { emit: mirrorEmit } as unknown as ClientProxy,
      makePinoLoggerMock() as unknown as PinoLogger,
    );
    mirrorSpy = jest.spyOn(mirror, 'mirror');
    publisher = new NotificationRabbitmqPublisher(
      { emit: notificationEmit } as unknown as ClientProxy,
      mirror,
    );
  });

  it('mirrors delivery.failed onto ris.events alongside the primary emit', async () => {
    await publisher.publishDeliveryFailed(failed);

    expect(notificationEmit).toHaveBeenCalledWith(
      ROUTING_KEYS.NOTIFICATIONS_DELIVERY_FAILED,
      failed,
    );
    expect(mirrorSpy).toHaveBeenCalledTimes(1);
    expect(mirrorSpy).toHaveBeenCalledWith(ROUTING_KEYS.NOTIFICATIONS_DELIVERY_FAILED, failed);
  });

  it('does not throw out of the publish method when the ris.events mirror fails', async () => {
    mirrorEmit.mockReturnValue(throwError(() => new Error('ris.events down')));

    await expect(publisher.publishDeliveryFailed(failed)).resolves.toBeUndefined();
    expect(notificationEmit).toHaveBeenCalledTimes(1);
  });
});
