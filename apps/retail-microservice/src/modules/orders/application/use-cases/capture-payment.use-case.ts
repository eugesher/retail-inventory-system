import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';

import { bodyFingerprint } from '@retail-inventory-system/common';
import {
  IIdempotentResult,
  IRetailPaymentCapturePayload,
  OrderView,
  PaymentStatusEnum,
} from '@retail-inventory-system/contracts';

import { Order, OrderDomainException, OrderErrorCodeEnum, Payment } from '../../domain';
import {
  IIdempotencyStorePort,
  IOrderEventsPublisherPort,
  IOrderRepositoryPort,
  IPaymentGatewayPort,
  IPaymentRepositoryPort,
  ITransactionPort,
  IDEMPOTENCY_STORE,
  ORDER_EVENTS_PUBLISHER,
  ORDER_REPOSITORY,
  PAYMENT_GATEWAY,
  PAYMENT_REPOSITORY,
  TRANSACTION_PORT,
} from '../ports';
import { loadAuthorizedOrder } from './order-access';
import { toOrderView } from './order-view.factory';

// Capture Payment is the explicit, second half of the authorize-then-capture policy
// (Q5 / ADR-028 §3). Authorization happens automatically at place-time; capture
// (taking the money) is a separate operation an operator or the owning customer
// triggers later. Making capture explicit is what keeps other policies achievable —
// ship-triggered auto-capture is a later fulfillment capability, not baked into the
// place flow.
//
// **Authorization is owner-or-staff** (ADR-024 / ADR-028 §7), enforced here as the
// single point of truth: allow if `isStaffCapture` (the gateway already confirmed the
// caller carries `order:capture`) **or** `order.customerId === actorId` (the owning
// customer) — else `ORDER_ACCESS_FORBIDDEN` (403). The permission code is a staff
// override over the owner-check, not a customer gate.
//
// **Two idempotency layers (ADR-036).** First the request-level `Idempotency-Key`:
// `execute` fingerprints the canonical body (`bodyFingerprint`), looks the
// `(scope='capture-payment', key)` pair up in the `IDEMPOTENCY_STORE`, and on a
// same-key/same-body hit **replays the stored `OrderView` before any side effect** — no
// gateway call, no transition, no `retail.payment.captured` emit (the replay returns
// before `capture`, which owns the whole flow including the emit). A same-key/*different*-
// body hit is a client key-reuse bug → `422`; a missing key is a `400` backstop (the
// gateway enforces the header at the edge). Second, the natural idempotency remains the
// backstop: re-capturing an already-`captured` payment returns the current `captured`
// state rather than erroring (so a new-key re-capture is still safe). `amountMinor` is
// accepted for forward-compat, but partial capture is a later capability — the gateway
// always captures the full authorized amount, and the emitted event reports the payment
// row's actual amount.
//
// The gateway `capture` call is **out-of-process**, so it runs outside the DB
// transaction (the authorize-on-place rationale); only the two writes that follow —
// advance the `Payment` to `captured`, advance `Order.markPaymentCaptured()` — run
// together in a short follow-up transaction.
@Injectable()
export class CapturePaymentUseCase {
  constructor(
    @Inject(TRANSACTION_PORT)
    private readonly transactionPort: ITransactionPort,
    @Inject(PAYMENT_GATEWAY)
    private readonly paymentGateway: IPaymentGatewayPort,
    @Inject(PAYMENT_REPOSITORY)
    private readonly paymentRepository: IPaymentRepositoryPort,
    @Inject(ORDER_REPOSITORY)
    private readonly orderRepository: IOrderRepositoryPort,
    @Inject(ORDER_EVENTS_PUBLISHER)
    private readonly publisher: IOrderEventsPublisherPort,
    @Inject(IDEMPOTENCY_STORE)
    private readonly idempotencyStore: IIdempotencyStorePort,
    @InjectPinoLogger(CapturePaymentUseCase.name)
    private readonly logger: PinoLogger,
  ) {}

  // The scope namespaces the client key by operation, so the same `Idempotency-Key`
  // reused for a capture and (say) a ship cannot collide in the store (ADR-036).
  private static readonly SCOPE = 'capture-payment';

  public async execute(
    payload: IRetailPaymentCapturePayload,
  ): Promise<IIdempotentResult<OrderView>> {
    const { idempotencyKey, correlationId, orderId } = payload;

    // Defensive backstop for the gateway's required-header edge check: a direct RMQ
    // caller that bypassed the gateway still fails fast here (ADR-036).
    if (!idempotencyKey) {
      throw new OrderDomainException(
        OrderErrorCodeEnum.ORDER_IDEMPOTENCY_KEY_REQUIRED,
        'An Idempotency-Key is required to capture a payment',
      );
    }

    // Fingerprint the CANONICAL body — the client-controlled capture command minus
    // transport/identity noise (`correlationId`, `idempotencyKey`, and the owner/staff
    // ids), so a retry under a fresh correlation id still matches (ADR-036).
    const fingerprint = bodyFingerprint(CapturePaymentUseCase.canonicalBody(payload));

    // Key-store lookup FIRST. A matching-fingerprint hit replays the stored `OrderView`
    // WITHOUT touching the gateway and WITHOUT re-emitting — this branch returns before
    // `capture`, which owns the whole flow. A different-fingerprint hit is one key reused
    // for a different body → 422.
    const prior = await this.idempotencyStore.find(CapturePaymentUseCase.SCOPE, idempotencyKey);
    if (prior) {
      if (prior.requestFingerprint === fingerprint) {
        this.logger.debug(
          { correlationId, orderId, idempotencyKey },
          'Idempotent replay — returning the stored capture response (no re-execution, no events)',
        );
        return { view: prior.responseBody as unknown as OrderView, replayed: true };
      }
      throw new OrderDomainException(
        OrderErrorCodeEnum.ORDER_IDEMPOTENCY_KEY_REUSED,
        `Idempotency-Key ${idempotencyKey} was already used for a capture-payment request with a different body`,
      );
    }

    // Miss — run the capture (the natural payment-state idempotency still applies inside),
    // then persist the stored response so the next identical retry replays.
    const view = await this.capture(payload);
    await this.idempotencyStore.save({
      scope: CapturePaymentUseCase.SCOPE,
      key: idempotencyKey,
      requestFingerprint: fingerprint,
      // The capture route is `200 OK`; the gateway forces `200` on any replay anyway.
      responseStatus: HttpStatus.OK,
      responseBody: view as unknown as Record<string, unknown>,
    });

    // Authoritative re-read: if a concurrent identical capture stored first, `save`
    // swallowed our duplicate — return the winner's stored response so both racers
    // converge (the natural payment-state idempotency guarantees the same order either way).
    const stored = await this.idempotencyStore.find(CapturePaymentUseCase.SCOPE, idempotencyKey);
    if (stored && (stored.responseBody as { id?: number }).id !== view.id) {
      this.logger.debug(
        { correlationId, orderId, idempotencyKey },
        'Idempotent replay — a concurrent capture stored first; returning the winning response',
      );
      return { view: stored.responseBody as unknown as OrderView, replayed: true };
    }
    return { view, replayed: false };
  }

  // Builds the stable logical body the fingerprint covers: the client-controlled capture
  // command only. `correlationId` / `idempotencyKey` and the owner-injected `actorId` /
  // `isStaffCapture` are excluded, so the same intent under a fresh correlation id
  // fingerprints identically (ADR-036). `amountMinor` may be `undefined` — the fingerprint
  // helper drops undefined keys, so it hashes the same as an absent amount.
  private static canonicalBody(payload: IRetailPaymentCapturePayload): Record<string, unknown> {
    return {
      orderId: payload.orderId,
      amountMinor: payload.amountMinor,
    };
  }

  // The capture flow proper (run on a store miss): owner-or-staff authorization, the
  // natural payment-state idempotency, the out-of-process gateway capture, the short
  // follow-up transaction, and the post-commit `retail.payment.captured` emit. Returns the
  // `OrderView`.
  private async capture(payload: IRetailPaymentCapturePayload): Promise<OrderView> {
    const { orderId, actorId, isStaffCapture, amountMinor, idempotencyKey, correlationId } =
      payload;

    this.logger.info(
      { correlationId, orderId, actorId, isStaffCapture, idempotencyKey },
      'Capturing payment',
    );

    // Owner-or-staff authorization (ADR-028 §7): a customer may capture only its own
    // order; staff with `order:capture` (folded into `isStaffCapture`) may capture
    // any. A missing order is a 404, a non-owner-non-staff caller a 403.
    const order = await loadAuthorizedOrder(this.orderRepository, orderId, actorId, isStaffCapture);

    const payment = await this.paymentRepository.findByOrderId(orderId);
    if (!payment) {
      // A placed order is always authorized-on-place, so a missing payment means the
      // authorize never produced one — there is nothing to capture (409).
      throw new OrderDomainException(
        OrderErrorCodeEnum.ORDER_INVALID_PAYMENT_TRANSITION,
        `Order ${orderId} has no authorized payment to capture`,
      );
    }

    // Idempotent re-capture: an already-captured payment returns the current state
    // (the cart-state-idempotency analogue for capture — Q10), never a second gateway
    // call or a duplicate transition.
    if (payment.status === PaymentStatusEnum.CAPTURED) {
      this.logger.info(
        { correlationId, orderId, paymentId: payment.id },
        'Payment already captured — returning current state (idempotent)',
      );
      return toOrderView(order, payment);
    }

    // Any other non-authorized state (failed / voided / refunded) cannot be captured.
    if (payment.status !== PaymentStatusEnum.AUTHORIZED) {
      throw new OrderDomainException(
        OrderErrorCodeEnum.PAYMENT_INVALID_STATUS_TRANSITION,
        `Payment for order ${orderId} cannot be captured from status ${payment.status}`,
      );
    }

    // `amountMinor` is accepted for forward-compat but partial capture is a later
    // capability — the gateway captures the full authorized amount regardless, so
    // the requested figure is only logged (the emitted event reports the payment
    // row's actual amount, never an uncaptured request).
    if (amountMinor !== undefined && amountMinor !== order.grandTotalMinor) {
      this.logger.info(
        { correlationId, orderId, requestedAmountMinor: amountMinor },
        'Partial capture is not supported yet — capturing the full authorized amount',
      );
    }

    // Out-of-process gateway call — deliberately outside the DB transaction.
    const result = await this.paymentGateway.capture(payment.gatewayReference, correlationId);
    if (!result.captured) {
      this.logger.warn({ correlationId, orderId }, 'Payment gateway declined capture');
      throw new OrderDomainException(
        OrderErrorCodeEnum.ORDER_PAYMENT_NOT_CAPTURED,
        `Payment capture was declined for order ${orderId}`,
      );
    }

    // Short follow-up transaction: advance the Payment and the order's payment axis
    // atomically.
    await this.transactionPort.runInTransaction(async (scope) => {
      payment.capture(result.capturedAt);
      await this.paymentRepository.save(payment, scope);

      const fresh = await this.orderRepository.findById(orderId, scope);
      if (!fresh) {
        throw new OrderDomainException(
          OrderErrorCodeEnum.ORDER_NOT_FOUND,
          `Order ${orderId} not found while capturing payment`,
        );
      }
      fresh.markPaymentCaptured();
      await this.orderRepository.save(fresh, scope);
    });

    // Re-read so the view carries the advanced `paymentStatus` + the captured payment.
    // The two reads hit different tables with no data dependency, so run them
    // concurrently rather than paying both round-trips serially.
    const [finalOrder, finalPayment] = await Promise.all([
      this.orderRepository.findById(orderId),
      this.paymentRepository.findByOrderId(orderId),
    ]);
    if (!finalOrder || !finalPayment) {
      throw new Error(`CapturePaymentUseCase: order ${orderId} vanished after capture`);
    }

    await this.emitCaptured(finalOrder, finalPayment, idempotencyKey, correlationId);

    this.logger.info({ correlationId, orderId, paymentId: finalPayment.id }, 'Payment captured');
    return toOrderView(finalOrder, finalPayment);
  }

  // Best-effort, post-commit (ADR-020). The capture has already committed, so a
  // publish failure is warn-logged and swallowed — it never fails the capture.
  private async emitCaptured(
    order: Order,
    payment: Payment,
    idempotencyKey: string | undefined,
    correlationId: string,
  ): Promise<void> {
    try {
      await this.publisher.publishPaymentCaptured({
        orderId: order.id!,
        paymentId: payment.id!,
        // The payment row's actual amount — the gateway captured the full
        // authorized figure, so a caller-requested partial amount never leaks
        // into the event as if it had been captured.
        amountMinor: payment.amountMinor,
        currency: payment.currency,
        eventVersion: 'v1',
        occurredAt: (payment.capturedAt ?? new Date()).toISOString(),
        correlationId,
      });
    } catch (error) {
      this.logger.warn(
        { err: error as Error, correlationId, orderId: order.id, idempotencyKey },
        'Failed to publish retail.payment.captured (capture already committed)',
      );
    }
  }
}
