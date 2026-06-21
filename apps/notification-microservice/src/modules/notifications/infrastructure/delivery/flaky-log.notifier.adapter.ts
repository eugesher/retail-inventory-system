import { Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';

import { Notification } from '../../domain';
import { INotifierPort } from '../../application/ports';

// Marker token a delivery's rendered body carries to make this adapter fail it exactly
// once. A test seeds a template whose body contains this token; every other delivery
// (no marker) is dispatched normally.
export const FLAKY_NOTIFIER_FAIL_MARKER = '__FAIL_ONCE__';

// A TEST-ONLY `INotifierPort` that is deliberately, deterministically flaky — used to
// exercise the delivery retry path (failed → manual/scheduled retry → sent) without a real
// flaky transport. It is bound as `NOTIFIER` only when `NOTIFIER_TEST_FLAKY` is set at
// wiring time (`notifications.module.ts` selects it over `LogNotifierAdapter`); production
// never sets the flag, so this adapter is inert there.
//
// Even when bound, it is doubly isolated so other suites are unaffected:
//  1. It fails ONLY a delivery whose rendered body contains `FLAKY_NOTIFIER_FAIL_MARKER`.
//     A normal delivery (no marker) is logged and succeeds, exactly like
//     `LogNotifierAdapter`.
//  2. It fails a marked delivery only the FIRST time per content signature
//     (recipient|subject|body). A retry re-dispatches the SAME already-rendered subject and
//     body (the retry path never re-renders), so its signature matches the failed one and
//     it succeeds — modelling a transient failure that clears on retry.
@Injectable()
export class FlakyLogNotifierAdapter implements INotifierPort {
  // Content signatures this adapter has already failed once. In-memory and per-process —
  // a fresh microservice instance starts with an empty set (the desired test behavior:
  // the first marked send of a run fails, its retry succeeds).
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
