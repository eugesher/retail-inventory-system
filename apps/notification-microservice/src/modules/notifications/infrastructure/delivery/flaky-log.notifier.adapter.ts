import { Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';

import { Notification } from '../../domain';
import { INotifierPort } from '../../application/ports';

export const FLAKY_NOTIFIER_FAIL_MARKER = '__FAIL_ONCE__';

@Injectable()
export class FlakyLogNotifierAdapter implements INotifierPort {
  private readonly failedSignatures = new Set<string>();

  constructor(
    @InjectPinoLogger(FlakyLogNotifierAdapter.name)
    private readonly logger: PinoLogger,
  ) {}

  public async send(notification: Notification): Promise<void> {
    const signature = `${notification.recipient}|${notification.subject}|${notification.body}`;
    const carriesMarker = notification.body.includes(FLAKY_NOTIFIER_FAIL_MARKER);

    if (carriesMarker && !this.failedSignatures.has(signature)) {
      this.failedSignatures.add(signature);
      this.logger.warn(
        { recipient: notification.recipient, subject: notification.subject },
        'Flaky test notifier: simulating a first-attempt delivery failure',
      );
      throw new Error(`Flaky test notifier: simulated failure (${FLAKY_NOTIFIER_FAIL_MARKER})`);
    }

    this.logger.info(
      {
        recipient: notification.recipient,
        channel: notification.channel,
        subject: notification.subject,
        body: notification.body,
        metadata: notification.metadata,
      },
      'Notification dispatched (flaky test notifier)',
    );

    return Promise.resolve();
  }
}
