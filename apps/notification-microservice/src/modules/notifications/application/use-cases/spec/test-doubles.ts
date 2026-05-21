import { Notification } from '../../../domain';
import { INotifierPort } from '../../ports';

export class InMemoryNotifier implements INotifierPort {
  public readonly sent: Notification[] = [];

  public send(notification: Notification): Promise<void> {
    this.sent.push(notification);
    return Promise.resolve();
  }
}

export class FakeLogger {
  public readonly assignments: Record<string, unknown>[] = [];
  public readonly logs: { context: unknown; message?: string }[] = [];

  public assign(context: Record<string, unknown>): void {
    this.assignments.push(context);
  }

  public info(context: unknown, message?: string): void {
    this.logs.push({ context, message });
  }
}
