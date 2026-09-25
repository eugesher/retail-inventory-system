import { Controller, Inject } from '@nestjs/common';
import { EventPattern, Payload } from '@nestjs/microservices';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';

import { IRetailOrderCancelledEvent } from '@retail-inventory-system/contracts';
import { ROUTING_KEYS } from '@retail-inventory-system/messaging';

import { IPaymentRepositoryPort, PAYMENT_REPOSITORY } from '../../application/ports';
import { IssueRefundUseCase } from '../../application/use-cases';

@Controller()
export class OrderCancelledConsumer {
  constructor(
    private readonly issueRefund: IssueRefundUseCase,
    @Inject(PAYMENT_REPOSITORY)
    private readonly paymentRepository: IPaymentRepositoryPort,
    @InjectPinoLogger(OrderCancelledConsumer.name)
    private readonly logger: PinoLogger,
  ) {}

  @EventPattern(ROUTING_KEYS.RETAIL_ORDER_CANCELLED)
  public async onOrderCancelled(@Payload() event: IRetailOrderCancelledEvent): Promise<void> {
    const { orderId, paymentFlaggedForRefund, correlationId } = event;

    if (paymentFlaggedForRefund !== true) {
      this.logger.debug(
        { correlationId, orderId },
        'Order cancelled without a captured payment flagged for refund — nothing to auto-refund',
      );
      return;
    }

    try {
      await this.autoRefund(orderId, correlationId);
    } catch (error) {
      this.logger.warn(
        { err: error as Error, correlationId, orderId },
        'Auto-refund from cancel failed — payment stays flagged for refund (manual retry)',
      );
    }
  }

  private async autoRefund(orderId: number, correlationId: string): Promise<void> {
    const payment = await this.paymentRepository.findByOrderId(orderId);
    if (!payment) {
      this.logger.warn(
        { correlationId, orderId },
        'Order flagged for refund but has no payment row — skipping auto-refund',
      );
      return;
    }

    const refundable = payment.amountMinor - payment.refundedAmountMinor;
    if (refundable <= 0) {
      this.logger.info(
        { correlationId, orderId, paymentId: payment.id },
        'Cancelled order already fully refunded — auto-refund is a no-op (idempotent redelivery)',
      );
      return;
    }

    this.logger.info(
      { correlationId, orderId, paymentId: payment.id, amountMinor: refundable },
      'Auto-refunding cancelled order for the full refundable remainder',
    );

    await this.issueRefund.execute({
      orderId,
      paymentId: payment.id!,
      amountMinor: refundable,
      reason: 'order-cancelled',
      actorId: null,
      idempotencyKey: `order-cancelled:${orderId}:${payment.id}`,
      correlationId,
    });
  }
}
