import { PinoLogger } from 'nestjs-pino';

import { NotificationChannelEnum } from '@retail-inventory-system/contracts';

import { RenderAndDispatchUseCase } from '../../application/use-cases';

export interface ICustomerEmailDispatch {
  eventType: string;
  eventReferenceType: string;
  eventReferenceId: string;
  recipientCustomerId: string | null;
  customerEmail: string | null | undefined;
  context: Record<string, unknown>;
  correlationId: string;
}

export async function dispatchCustomerEmailNotification(
  renderAndDispatch: RenderAndDispatchUseCase,
  logger: PinoLogger,
  params: ICustomerEmailDispatch,
): Promise<void> {
  if (params.customerEmail == null || params.customerEmail.trim().length === 0) {
    logger.warn(
      {
        correlationId: params.correlationId,
        eventType: params.eventType,
        eventReferenceType: params.eventReferenceType,
        eventReferenceId: params.eventReferenceId,
      },
      'Customer-facing event has no recipient email; skipping notification',
    );
    return;
  }

  await renderAndDispatch.execute({
    eventType: params.eventType,
    channel: NotificationChannelEnum.EMAIL,
    recipientCustomerId: params.recipientCustomerId,
    recipientAddress: params.customerEmail,
    eventReferenceType: params.eventReferenceType,
    eventReferenceId: params.eventReferenceId,
    context: params.context,
    correlationId: params.correlationId,
  });
}
