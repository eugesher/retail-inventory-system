import { RequestMethod } from '@nestjs/common';
import { MiddlewareConfigProxy } from '@nestjs/common/interfaces';
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

// Pino logger configuration. Relocated from
// `libs/config/logger-module.config.ts` unchanged. The `traceId`/`spanId`
// enrichment hook lands as a stub; task-10 wires it to the active OTel
// context via `tracer.ts`.
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
          // Stub for task-10: enrich `inputArgs[0]` with active
          // OTel `trace_id`/`span_id` before forwarding. Today this is a
          // no-op because `tracer.ts` does not start an SDK yet.
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
