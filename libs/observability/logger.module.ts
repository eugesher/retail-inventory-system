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

const E2E_PINO_DESTINATION_KEY = '__RIS_E2E_PINO_DESTINATION__';

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
