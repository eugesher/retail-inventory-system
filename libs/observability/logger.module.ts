import { RequestMethod } from '@nestjs/common';
import { MiddlewareConfigProxy } from '@nestjs/common/interfaces';
import { trace } from '@opentelemetry/api';
import { Params } from 'nestjs-pino';
import { DestinationStream, levels, LogFn } from 'pino';
import { Options } from 'pino-http';

import { AppNameEnum } from '@retail-inventory-system/contracts';

const NOISY_CONTEXTS = new Set<string>([
  'InstanceLoader',
  'NestFactory',
  'NestApplication',
  'NestMicroservice',
  'RouterExplorer',
  'RoutesResolver',
]);

// E2E test hook: when a writable destination has been installed on this
// `globalThis` key (via libs/observability/testing/pino-memory-stream.ts),
// pino writes JSON records straight to it and the pino-pretty transport
// is suppressed. Production never sets the key, so the branch is inert
// outside of test bootstraps. Documented in TEST-002 of
// audit-2026-05-20-followup.
//
// The stream is plumbed via the nestjs-pino tuple form
// `pinoHttp: [Options, DestinationStream]` — pino-http forwards the
// second positional arg into `pino()`'s destination slot. Nesting
// `stream` inside `Options` is silently ignored by pino-http and was
// the source of an empty-capture bug during initial implementation.
const E2E_PINO_DESTINATION_KEY = '__RIS_E2E_PINO_DESTINATION__';

// Pino logger configuration. The `logMethod` hook decorates every log
// record with `traceId`/`spanId` from the currently active OTel span so
// log lines and traces can be cross-filtered (ADR-015).
export class LoggerModuleConfig implements Params {
  public readonly pinoHttp: Options | [Options, DestinationStream];
  public readonly forRoutes: Parameters<MiddlewareConfigProxy['forRoutes']>;

  constructor(appName: AppNameEnum) {
    const isProduction = process.env.NODE_ENV === 'production';
    const customProps = { app: appName };
    const e2eDestination = (globalThis as { [E2E_PINO_DESTINATION_KEY]?: DestinationStream })[
      E2E_PINO_DESTINATION_KEY
    ];

    this.forRoutes = [{ path: '*path', method: RequestMethod.ALL }];

    const baseOptions: Options = {
      msgPrefix: `[${appName}] `,
      // When the e2e capture is active, force `debug` regardless of
      // `LOG_LEVEL`. CI deliberately sets `LOG_LEVEL=warn` to keep
      // pipeline logs lean, but that would drop the very `debug`-level
      // records (e.g. `cacheHit: true` from `StockCache.get`) the e2e
      // suite asserts against. Honoring the env var here is a real CI
      // regression — see CI failure on RIS-40 follow-up.
      level: e2eDestination
        ? 'debug'
        : (process.env.LOG_LEVEL ?? (isProduction ? 'info' : 'debug')),
      customProps: (): { app: AppNameEnum } => customProps,
      redact: {
        paths: ['req.headers.authorization', 'req.headers.cookie', 'res.headers["set-cookie"]'],
        remove: true,
      },
      hooks: {
        logMethod(inputArgs: Parameters<LogFn>, method: LogFn, level: number): void {
          if (
            !isProduction &&
            level === levels.values.info &&
            NOISY_CONTEXTS.has((inputArgs[0] as Record<string, unknown>).context as string)
          ) {
            return;
          }

          const spanContext = trace.getActiveSpan()?.spanContext();
          if (spanContext?.traceId && spanContext.spanId) {
            const first = inputArgs[0];
            const enrichment = { traceId: spanContext.traceId, spanId: spanContext.spanId };

            if (typeof first === 'object' && first !== null) {
              inputArgs[0] = { ...enrichment, ...(first as Record<string, unknown>) };
            } else {
              inputArgs.unshift(enrichment);
            }
          }

          method.apply(this, inputArgs);
        },
      },
    };

    if (e2eDestination) {
      // Tuple form: `pinoHttp(options, destination)` — see comment on
      // E2E_PINO_DESTINATION_KEY above for why this is required.
      this.pinoHttp = [baseOptions, e2eDestination];
    } else if (isProduction) {
      this.pinoHttp = baseOptions;
    } else {
      this.pinoHttp = {
        ...baseOptions,
        transport: {
          target: 'pino-pretty',
          options: {
            colorize: true,
            singleLine: false,
            translateTime: 'SYS:yyyy-mm-dd HH:MM:ss.l',
            ignore: 'pid,hostname',
          },
        },
      };
    }
  }
}
