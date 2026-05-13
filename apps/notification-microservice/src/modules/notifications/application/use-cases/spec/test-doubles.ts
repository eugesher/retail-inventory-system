import { Notification } from '../../../domain';
import { INotifierPort } from '../../ports';

// In-memory port double for the use-case unit tests. Captures every
// `send()` call so assertions can inspect the constructed Notification.
export class InMemoryNotifier implements INotifierPort {
  public readonly sent: Notification[] = [];

  public send(notification: Notification): Promise<void> {
    this.sent.push(notification);
    return Promise.resolve();
  }
}

// Minimal PinoLogger double — the use cases only invoke `assign` and `info`.
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
