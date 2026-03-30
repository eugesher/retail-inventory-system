import { RequestMethod } from '@nestjs/common';
import { MiddlewareConfigProxy } from '@nestjs/common/interfaces';
import { Params } from 'nestjs-pino';
import { levels, LogFn } from 'pino';
import { Options } from 'pino-http';

import { AppNameEnum } from '../../common';

const NOISY_CONTEXTS = new Set<string>([
  'InstanceLoader',
  'NestFactory',
  'NestApplication',
  'NestMicroservice',
  'RouterExplorer',
  'RoutesResolver',
]);

export class LoggerConfig implements Params {
  public readonly pinoHttp: Options;
  public readonly forRoutes: Parameters<MiddlewareConfigProxy['forRoutes']>;

  constructor(appName: AppNameEnum) {
    const isProduction = process.env.NODE_ENV === 'production';
    const customProps = { app: appName };

    this.forRoutes = [{ path: '*path', method: RequestMethod.ALL }];

    this.pinoHttp = {
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
          method.apply(this, inputArgs);
        },
      },
    };

    if (!isProduction) {
      this.pinoHttp.transport = {
        target: 'pino-pretty',
        options: {
          colorize: true,
          singleLine: false,
          translateTime: 'SYS:yyyy-mm-dd HH:MM:ss.l',
          ignore: 'pid,hostname',
        },
      };
    }
  }
}
