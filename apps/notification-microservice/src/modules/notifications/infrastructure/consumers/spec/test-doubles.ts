import { NotificationDelivery } from '../../../domain';
import { IRenderAndDispatchInput } from '../../../application/use-cases';

export class RecordingRenderAndDispatch {
  public readonly inputs: IRenderAndDispatchInput[] = [];

  public execute(input: IRenderAndDispatchInput): Promise<NotificationDelivery | null> {
    this.inputs.push(input);
    return Promise.resolve(null);
  }
}

export class FakeLogger {
  public readonly warns: { context: unknown; message?: string }[] = [];
  public readonly infos: { context: unknown; message?: string }[] = [];

  public warn(context: unknown, message?: string): void {
    this.warns.push({ context, message });
  }

  public info(context: unknown, message?: string): void {
    this.infos.push({ context, message });
  }
}
