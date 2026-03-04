import { ConsoleLogger, Injectable, LoggerService } from '@nestjs/common';

@Injectable()
export class CleanBootstrapLogger extends ConsoleLogger implements LoggerService {
  public log(message: unknown, context?: unknown): void {
    const noisyContexts = ['InstanceLoader', 'RouterExplorer', 'RoutesResolver'];

    if (typeof context === 'string' && noisyContexts.includes(context)) {
      return;
    }

    super.log(message, context);
  }
}
