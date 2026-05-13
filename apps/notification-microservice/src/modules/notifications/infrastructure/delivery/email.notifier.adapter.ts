import { Injectable } from '@nestjs/common';

import { Notification } from '../../domain';
import { INotifierPort } from '../../application/ports';

// Scaffold only. TODO(post-migration): wire an SMTP transport (nodemailer or
// a managed provider) and rebind `NOTIFIER` in `notifications.module.ts`.
// The dependency is intentionally not in `package.json` yet — adding it now
// would force a choice of provider before the business need is settled.
@Injectable()
export class EmailNotifierAdapter implements INotifierPort {
  public send(notification: Notification): Promise<void> {
    void notification;
    throw new Error('EmailNotifierAdapter: not implemented');
  }
}
