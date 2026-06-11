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

// The business input to Authorize Payment. `orderId` / `amountMinor` / `currency`
// describe the charge; `method` is the optional opaque method token from the caller
// (forwarded to the gateway); `correlationId` threads the request id for logging.
export interface IAuthorizePaymentInput {
  orderId: number;
  amountMinor: number;
  currency: string;
  method?: string;
  correlationId?: string;
}

// Authorize Payment is the inline authorize-on-place half of Q5 (ADR-028 §3): it
// calls the `PAYMENT_GATEWAY` (the always-approve fake by default; a real processor
// by rebinding), and on approval persists a `Payment` in `AUTHORIZED` and advances
// the order's payment axis to `authorized`.
//
// The external gateway call is an out-of-process request, so it runs **outside** the
// DB transaction; only the two writes that follow it — persist the `Payment`, save
// the `Order` with `markPaymentAuthorized()` — run together in a short follow-up
// transaction (`TRANSACTION_PORT`). On a non-approval (unreachable with the fake,
// but modeled) the order stays `paymentStatus=none` and a typed `409` is surfaced.
//
// It is its own use case (not inlined into Place Order) so it is unit-testable
// against a fake `PAYMENT_GATEWAY` in isolation, and so the later explicit-capture
// capability can sit alongside it symmetrically.
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

    // Out-of-process gateway call — deliberately outside the DB transaction.
    const result = await this.paymentGateway.authorize({
      orderId,
      amountMinor,
      currency,
      method,
      correlationId,
    });

    if (!result.approved) {
      // The order is already placed (committed by Place Order's transaction); leave
      // its payment axis `none` and surface a typed rejection.
      this.logger.warn({ correlationId, orderId }, 'Payment gateway declined authorize');
      throw new OrderDomainException(
        OrderErrorCodeEnum.ORDER_PAYMENT_NOT_APPROVED,
        `Payment authorize was declined for order ${orderId}`,
      );
    }

    // Short follow-up transaction: persist the Payment and advance the order's
    // payment axis atomically.
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
