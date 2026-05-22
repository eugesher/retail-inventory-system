import { Notification } from '../../domain';

export const NOTIFIER = Symbol('NOTIFIER');

// Use cases depend on this symbol; the concrete transport (log / email /
// webhook) is selected by `notifications.module.ts`.
export interface INotifierPort {
  send(notification: Notification): Promise<void>;
}
