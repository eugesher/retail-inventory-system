import { Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';

import { Notification } from '../../domain';
import { INotifierPort } from '../../application/ports';

// Default adapter — emits the notification as a structured Pino log line.
// Useful as a development sink and as the canonical implementation that the
// E2E smoke test asserts against. Real channels (email, webhook) replace
// this via a single DI rebind in `notifications.module.ts`.
@Injectable()
export class LogNotifierAdapter implements INotifierPort {
  constructor(
    @InjectPinoLogger(LogNotifierAdapter.name)
    private readonly logger: PinoLogger,
  ) {}

  public async send(notification: Notification): Promise<void> {
    this.logger.info(
      {
        recipient: notification.recipient,
        channel: notification.channel,
        subject: notification.subject,
        body: notification.body,
        metadata: notification.metadata,
      },
      'Notification dispatched',
    );

    return Promise.resolve();
  }
}
