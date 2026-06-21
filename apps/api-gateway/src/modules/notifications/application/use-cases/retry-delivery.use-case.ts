import { Inject, Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';

import { NotificationDeliveryView } from '@retail-inventory-system/contracts';

import { throwRpcError } from '../../../../common/utils';
import {
  INotificationsGatewayPort,
  IRetryDeliveryCommand,
  NOTIFICATIONS_GATEWAY_PORT,
} from '../ports';

// Thin gateway-side orchestrator over the `notification.delivery.retry` RPC — the
// operator manual retry of one **failed** delivery. The re-dispatch of the
// already-rendered content + the cap-exhaustion event are the notification
// microservice's responsibility; the gateway threads the correlation id and maps a
// downstream rejection (an unknown id is a 404, a non-`failed` source a 409) onto
// the right HTTP status via `throwRpcError`.
@Injectable()
export class RetryDeliveryUseCase {
  constructor(
    @Inject(NOTIFICATIONS_GATEWAY_PORT)
    private readonly notificationsGateway: INotificationsGatewayPort,
    @InjectPinoLogger(RetryDeliveryUseCase.name)
    private readonly logger: PinoLogger,
  ) {}

  public async execute(
    command: IRetryDeliveryCommand,
    correlationId: string,
  ): Promise<NotificationDeliveryView> {
    this.logger.assign({ correlationId });

    try {
      this.logger.info({ deliveryId: command.deliveryId }, 'Retrying notification delivery');

      const delivery = await this.notificationsGateway.retryDelivery(command, correlationId);

      this.logger.info(
        { id: delivery.id, status: delivery.status, attemptCount: delivery.attemptCount },
        'Notification delivery retried',
      );

      return delivery;
    } catch (error) {
      this.logger.error(error, 'Error retrying notification delivery');

      throwRpcError(error);
    }
  }
}
