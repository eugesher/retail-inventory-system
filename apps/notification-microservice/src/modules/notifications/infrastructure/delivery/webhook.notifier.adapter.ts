import { Injectable } from '@nestjs/common';

import { Notification } from '../../domain';
import { INotifierPort } from '../../application/ports';

// Scaffold only. TODO(post-migration): POST the serialized notification to a
// configured webhook URL (with retries + signed payloads). Kept as a stub so
// the adapter slot exists in the DI graph and ADR-011 can reference it.
@Injectable()
export class WebhookNotifierAdapter implements INotifierPort {
  public send(notification: Notification): Promise<void> {
    void notification;
    throw new Error('WebhookNotifierAdapter: not implemented');
  }
}
