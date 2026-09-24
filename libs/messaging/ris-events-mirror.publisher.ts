import { Inject, Injectable } from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { firstValueFrom, timeout } from 'rxjs';

import {
  ICorrelationPayload,
  MicroserviceClientTokenEnum,
} from '@retail-inventory-system/contracts';

export const BEST_EFFORT_EMIT_TIMEOUT_MS = 5_000;

export async function emitBestEffort<T extends ICorrelationPayload>(
  client: ClientProxy,
  routingKey: string,
  payload: T,
  logger: PinoLogger,
  failMessage: string,
  timeoutMs: number = BEST_EFFORT_EMIT_TIMEOUT_MS,
): Promise<void> {
  try {
    await firstValueFrom(
      client.emit<void, T>(routingKey, payload).pipe(timeout({ each: timeoutMs })),
    );
  } catch (error) {
    logger.warn(
      { routingKey, correlationId: payload.correlationId, payload, err: error as Error },
      failMessage,
    );
  }
}

@Injectable()
export class RisEventsMirrorPublisher {
  constructor(
    @Inject(MicroserviceClientTokenEnum.RIS_EVENTS_PUBLISHER)
    private readonly client: ClientProxy,
    @InjectPinoLogger(RisEventsMirrorPublisher.name)
    private readonly logger: PinoLogger,
  ) {}

  public async mirror(routingKey: string, payload: ICorrelationPayload): Promise<void> {
    await emitBestEffort(
      this.client,
      routingKey,
      payload,
      this.logger,
      'Failed to mirror event onto ris.events',
    );
  }
}
