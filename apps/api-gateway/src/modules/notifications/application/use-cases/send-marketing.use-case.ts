import { Inject, Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';

import { throwRpcError } from '../../../../common/utils';
import {
  INotificationsGatewayPort,
  ISendMarketingCommand,
  MarketingSendResult,
  NOTIFICATIONS_GATEWAY_PORT,
} from '../ports';

// Thin gateway-side orchestrator over the `notification.marketing.send` RPC (ADR-037).
// The eventType-default and the per-request `campaignId` are resolved at the controller
// edge (the presentation layer may import `ROUTING_KEYS` for the marketing default; the
// application layer may not), so this use case only threads the correlation id and maps
// a downstream error onto the right HTTP status. The consent decision (send vs
// `skipped-no-consent`) is entirely the notification service's responsibility.
@Injectable()
export class SendMarketingUseCase {
  constructor(
    @Inject(NOTIFICATIONS_GATEWAY_PORT)
    private readonly notificationsGateway: INotificationsGatewayPort,
    @InjectPinoLogger(SendMarketingUseCase.name)
    private readonly logger: PinoLogger,
  ) {}

  public async execute(
    command: ISendMarketingCommand,
    correlationId: string,
  ): Promise<MarketingSendResult> {
    this.logger.assign({ correlationId });

    try {
      this.logger.info(
        {
          customerId: command.customerId,
          eventType: command.eventType,
          campaignId: command.campaignId,
        },
        'Sending marketing notification',
      );

      const delivery = await this.notificationsGateway.sendMarketing(command, correlationId);

      this.logger.info(
        { deliveryId: delivery?.id ?? null, status: delivery?.status ?? 'no-template' },
        'Marketing notification dispatched',
      );

      return delivery;
    } catch (error) {
      this.logger.error(error, 'Error sending marketing notification');

      throwRpcError(error);
    }
  }
}
