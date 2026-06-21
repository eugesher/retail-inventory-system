import { NotificationDelivery } from '../../../domain';
import { IRenderAndDispatchInput } from '../../../application/use-cases';

// Records every `IRenderAndDispatchInput` the consumer under test hands the pipeline, so a
// spec can assert the exact event → input mapping (eventType / reference type+id /
// recipient) without standing up the real template repo, renderer, and notifier — the
// persist-before-`NOTIFIER` ordering is proven in `render-and-dispatch.use-case.spec.ts`.
// `execute` resolves `null` (the no-template branch) because the consumers ignore the
// return; the spec only cares that it was called with the right shape.
export class RecordingRenderAndDispatch {
  public readonly inputs: IRenderAndDispatchInput[] = [];

  public execute(input: IRenderAndDispatchInput): Promise<NotificationDelivery | null> {
    this.inputs.push(input);
    return Promise.resolve(null);
  }
}

// A minimal stand-in for `PinoLogger`: the consumers only call `warn` (the missing-recipient
// skip branch); `info` is captured too so the double matches the logger surface the
// `@InjectPinoLogger` parameter expects when cast.
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
