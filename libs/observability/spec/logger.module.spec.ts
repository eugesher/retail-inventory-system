import { context, trace } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { BasicTracerProvider } from '@opentelemetry/sdk-trace-base';

import { AppNameEnum } from '@retail-inventory-system/contracts';

import { LoggerModuleConfig } from '../logger.module';

// The Pino `logMethod` hook is the seam where trace-correlation lives.
// Behavior we care about: when a span is active, every log record carries
// matching `traceId` / `spanId`; when no span is active, the hook is a
// passthrough (no enrichment fields are added).
describe('LoggerModuleConfig — trace-correlation hook', () => {
  const contextManager = new AsyncLocalStorageContextManager().enable();
  context.setGlobalContextManager(contextManager);
  const tracerProvider = new BasicTracerProvider();
  trace.setGlobalTracerProvider(tracerProvider);
  const tracer = trace.getTracer('logger-module.spec');

  const buildHook = (): {
    hook: (args: unknown[], method: (...a: unknown[]) => void, level: number) => void;
    captured: { args: unknown[] | null };
  } => {
    const config = new LoggerModuleConfig(AppNameEnum.API_GATEWAY);
    const captured: { args: unknown[] | null } = { args: null };
    return {
      hook: config.pinoHttp.hooks!.logMethod! as unknown as (
        args: unknown[],
        method: (...a: unknown[]) => void,
        level: number,
      ) => void,
      captured,
    };
  };

  it('injects active span traceId/spanId into a record-style log call', () => {
    const { hook, captured } = buildHook();
    const span = tracer.startSpan('test-span');
    context.with(trace.setSpan(context.active(), span), () => {
      const expected = span.spanContext();
      hook(
        [{ context: 'TestCtx', userId: 'u-1' }, 'hello'],
        function (this: unknown, ...a: unknown[]) {
          captured.args = a;
        } as never,
        30,
      );

      expect(captured.args).not.toBeNull();
      const record = captured.args![0] as Record<string, unknown>;
      expect(record.traceId).toBe(expected.traceId);
      expect(record.spanId).toBe(expected.spanId);
      expect(record.userId).toBe('u-1');
      expect(record.context).toBe('TestCtx');
    });
    span.end();
  });

  it('skips enrichment when no span is active', () => {
    const { hook, captured } = buildHook();
    hook(
      [{ context: 'TestCtx' }, 'plain'],
      function (this: unknown, ...a: unknown[]) {
        captured.args = a;
      } as never,
      30,
    );

    expect(captured.args).not.toBeNull();
    const record = captured.args![0] as Record<string, unknown>;
    expect(record.traceId).toBeUndefined();
    expect(record.spanId).toBeUndefined();
  });
});
