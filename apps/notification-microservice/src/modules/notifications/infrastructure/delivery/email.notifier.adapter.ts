import { Injectable } from '@nestjs/common';

import { Notification } from '../../domain';
import { INotifierPort } from '../../application/ports';

// Scaffold for a future SMTP transport — dependency deliberately not in
// `package.json` so the provider choice isn't forced before the business
// need is settled (ADR-011 §3).
@Injectable()
export class EmailNotifierAdapter implements INotifierPort {
  public send(notification: Notification): Promise<void> {
    void notification;
    throw new Error('EmailNotifierAdapter: not implemented');
  }
}
