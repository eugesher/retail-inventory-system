import { RequestMethod } from '@nestjs/common';
import { MiddlewareConfigProxy } from '@nestjs/common/interfaces';
import { trace } from '@opentelemetry/api';
import { Params } from 'nestjs-pino';
import { levels, LogFn } from 'pino';
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

// Pino logger configuration. The `logMethod` hook decorates every log
// record with `traceId`/`spanId` from the currently active OTel span so
// log lines and traces can be cross-filtered (ADR-015).
export class LoggerModuleConfig implements Params {
  public readonly pinoHttp: Options;
  public readonly forRoutes: Parameters<MiddlewareConfigProxy['forRoutes']>;

  constructor(appName: AppNameEnum) {
    const isProduction = process.env.NODE_ENV === 'production';
    const customProps = { app: appName };

    this.forRoutes = [{ path: '*path', method: RequestMethod.ALL }];

    this.pinoHttp = {
      msgPrefix: `[${appName}] `,
      level: process.env.LOG_LEVEL ?? (isProduction ? 'info' : 'debug'),
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
      ...(isProduction
        ? {}
        : {
            transport: {
              target: 'pino-pretty',
              options: {
                colorize: true,
                singleLine: false,
                translateTime: 'SYS:yyyy-mm-dd HH:MM:ss.l',
                ignore: 'pid,hostname',
              },
            },
          }),
    };
  }
}
