import { Notification } from '../../domain';

export const NOTIFIER = Symbol('NOTIFIER');

// Outbound delivery port. The concrete adapter (log, email, webhook, …) is
// injected by `notifications.module.ts`. Use cases depend on this symbol —
// never on a specific transport.
export interface INotifierPort {
  send(notification: Notification): Promise<void>;
}
