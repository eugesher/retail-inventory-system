import { Notification } from '../../domain';

export const NOTIFIER = Symbol('NOTIFIER');

export interface INotifierPort {
  send(notification: Notification): Promise<void>;
}
