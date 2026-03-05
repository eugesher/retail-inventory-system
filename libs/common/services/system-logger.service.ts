import { ConsoleLogger, Injectable, LoggerService } from '@nestjs/common';

@Injectable()
export class SystemLogger extends ConsoleLogger implements LoggerService {
  public log(message: unknown, context?: unknown): void {
    const noisyContexts = [
      'InstanceLoader',
      'NestFactory',
      'NestApplication',
      'NestMicroservice',
      'RouterExplorer',
      'RoutesResolver',
    ];

    if (typeof context === 'string' && noisyContexts.includes(context)) {
      return;
    }

    super.log(message, context);
  }
}
