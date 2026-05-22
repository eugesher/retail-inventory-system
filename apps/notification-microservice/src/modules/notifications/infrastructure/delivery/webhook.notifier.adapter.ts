import { Injectable } from '@nestjs/common';

import { Notification } from '../../domain';
import { INotifierPort } from '../../application/ports';

// Scaffold for a future webhook delivery channel — kept as a stub so the DI
// slot stays visible alongside `EmailNotifierAdapter` (ADR-011 §3).
@Injectable()
export class WebhookNotifierAdapter implements INotifierPort {
  public send(notification: Notification): Promise<void> {
    void notification;
    throw new Error('WebhookNotifierAdapter: not implemented');
  }
}
