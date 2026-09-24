import { Inject, Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';

import { OrderDomainException, OrderErrorCodeEnum, Payment } from '../../domain';
import {
  IOrderRepositoryPort,
  IPaymentGatewayPort,
  IPaymentRepositoryPort,
  ITransactionPort,
  ORDER_REPOSITORY,
  PAYMENT_GATEWAY,
  PAYMENT_REPOSITORY,
  TRANSACTION_PORT,
} from '../ports';

export interface IAuthorizePaymentInput {
  orderId: number;
  amountMinor: number;
  currency: string;
  method?: string;
  correlationId?: string;
}

@Injectable()
export class AuthorizePaymentUseCase {
  constructor(
    @Inject(TRANSACTION_PORT)
    private readonly transactionPort: ITransactionPort,
    @Inject(PAYMENT_GATEWAY)
    private readonly paymentGateway: IPaymentGatewayPort,
    @Inject(PAYMENT_REPOSITORY)
    private readonly paymentRepository: IPaymentRepositoryPort,
    @Inject(ORDER_REPOSITORY)
    private readonly orderRepository: IOrderRepositoryPort,
    @InjectPinoLogger(AuthorizePaymentUseCase.name)
    private readonly logger: PinoLogger,
  ) {}

  public async execute(input: IAuthorizePaymentInput): Promise<Payment> {
    const { orderId, amountMinor, currency, method, correlationId } = input;

    this.logger.info({ correlationId, orderId, amountMinor, currency }, 'Authorizing payment');

    const result = await this.paymentGateway.authorize({
      orderId,
      amountMinor,
      currency,
      method,
      correlationId,
    });

    if (!result.approved) {
      this.logger.warn({ correlationId, orderId }, 'Payment gateway declined authorize');
      throw new OrderDomainException(
        OrderErrorCodeEnum.ORDER_PAYMENT_NOT_APPROVED,
        `Payment authorize was declined for order ${orderId}`,
      );
    }

    const payment = await this.transactionPort.runInTransaction(async (scope) => {
      const authorized = Payment.authorized({
        orderId,
        amountMinor,
        currency,
        method: result.method,
        gatewayReference: result.gatewayReference,
        authorizedAt: result.authorizedAt,
      });
      const savedPayment = await this.paymentRepository.save(authorized, scope);

      const order = await this.orderRepository.findById(orderId, scope);
      if (!order) {
        throw new OrderDomainException(
          OrderErrorCodeEnum.ORDER_NOT_FOUND,
          `Order ${orderId} not found while authorizing payment`,
        );
      }
      order.markPaymentAuthorized();
      await this.orderRepository.save(order, scope);

      return savedPayment;
    });

    this.logger.info(
      { correlationId, orderId, paymentId: payment.id, gatewayReference: payment.gatewayReference },
      'Payment authorized',
    );
    return payment;
  }
}
