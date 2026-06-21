import { Inject, Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';

import {
  FulfillmentStatusEnum,
  FulfillmentView,
  IRetailFulfillmentDeliverPayload,
} from '@retail-inventory-system/contracts';

import { Fulfillment, OrderDomainException, OrderErrorCodeEnum } from '../../domain';
import {
  FULFILLMENT_REPOSITORY,
  IFulfillmentRepositoryPort,
  IOrderCustomerContactReaderPort,
  IOrderEventsPublisherPort,
  IOrderRepositoryPort,
  ITransactionPort,
  ORDER_CUSTOMER_CONTACT_READER,
  ORDER_EVENTS_PUBLISHER,
  ORDER_REPOSITORY,
  TRANSACTION_PORT,
} from '../ports';
import { loadAuthorizedOrder } from './order-access';
import { toFulfillmentView } from './fulfillment-view.factory';
import { resolveCustomerEmail } from './resolve-customer-email';

// Mark Delivered is the happy-path terminal of the ship flow (ADR-031): a carrier (or,
// since carrier webhooks are out of scope, an operator) confirms a `shipped` fulfillment
// arrived. It is the simplest of the lifecycle operations — it crosses no service
// boundary (the stock already shipped at Ship time via Commit Sale) and touches no
// payment (capture already happened at Ship): it only advances the per-shipment
// `Fulfillment → delivered` and, once **every** non-`cancelled` fulfillment of the order
// is delivered, rolls the order itself up to `delivered` on both its lifecycle and
// fulfillment axes.
//
// **Authorization is owner-or-staff** (ADR-024 / ADR-028 §7) via `loadAuthorizedOrder`:
// allow if `isStaffFulfill` (the gateway already confirmed `order:fulfill`) **or**
// `order.customerId === actorId`. Practically Deliver is staff-run (exposed as an admin
// endpoint, since carrier webhooks are out of scope).
@Injectable()
export class MarkDeliveredUseCase {
  constructor(
    @Inject(TRANSACTION_PORT)
    private readonly transactionPort: ITransactionPort,
    @Inject(ORDER_REPOSITORY)
    private readonly orderRepository: IOrderRepositoryPort,
    @Inject(FULFILLMENT_REPOSITORY)
    private readonly fulfillmentRepository: IFulfillmentRepositoryPort,
    @Inject(ORDER_EVENTS_PUBLISHER)
    private readonly publisher: IOrderEventsPublisherPort,
    @Inject(ORDER_CUSTOMER_CONTACT_READER)
    private readonly customerContactReader: IOrderCustomerContactReaderPort,
    @InjectPinoLogger(MarkDeliveredUseCase.name)
    private readonly logger: PinoLogger,
  ) {}

  public async execute(payload: IRetailFulfillmentDeliverPayload): Promise<FulfillmentView> {
    const { orderId, fulfillmentId, actorId, isStaffFulfill, correlationId } = payload;

    this.logger.info(
      { correlationId, orderId, fulfillmentId, actorId, isStaffFulfill },
      'Marking fulfillment delivered',
    );

    // Owner-or-staff authorization + existence (404 missing / 403 non-owner-non-staff). The
    // order carries the `customerId` the post-commit event's email is resolved from.
    const order = await loadAuthorizedOrder(this.orderRepository, orderId, actorId, isStaffFulfill);

    // Load the fulfillment + assert it is deliverable: it must belong to this order and
    // be `shipped` (the domain `markDelivered` re-guards inside the tx — this is the
    // clean early reject before opening a transaction).
    const fulfillment = await this.fulfillmentRepository.findById(fulfillmentId);
    if (fulfillment?.orderId !== orderId) {
      throw new OrderDomainException(
        OrderErrorCodeEnum.FULFILLMENT_NOT_FOUND,
        `Fulfillment ${fulfillmentId} not found on order ${orderId}`,
      );
    }
    if (fulfillment.status !== FulfillmentStatusEnum.SHIPPED) {
      throw new OrderDomainException(
        OrderErrorCodeEnum.FULFILLMENT_INVALID_STATUS_TRANSITION,
        `Fulfillment ${fulfillmentId} is ${fulfillment.status} and cannot be delivered`,
      );
    }

    const deliveredAt = new Date();

    // Local transaction: deliver the fulfillment, and — if it was the last outstanding
    // one — roll the order up to `delivered` on both axes, atomically. Returns the
    // delivered fulfillment so the post-commit emit runs on the concrete graph.
    const delivered = await this.transactionPort.runInTransaction<Fulfillment>(async (scope) => {
      // Re-read under a pessimistic write lock — the same single-writer-per-status-
      // transition guard Ship and Cancel take (ADR-031). A concurrent Deliver of the
      // same fulfillment serialises here: the loser blocks until the winner commits,
      // then observes the now-`delivered` status and `fresh.markDelivered()` below
      // rejects it (a non-`shipped` status → FULFILLMENT_INVALID_STATUS_TRANSITION), so
      // the order roll-up never runs twice and no duplicate `delivered` event fires.
      const fresh = await this.fulfillmentRepository.findByIdForUpdate(fulfillmentId, scope);
      if (!fresh) {
        throw new OrderDomainException(
          OrderErrorCodeEnum.FULFILLMENT_NOT_FOUND,
          `Fulfillment ${fulfillmentId} vanished while delivering`,
        );
      }
      // The domain enforces the `shipped → delivered` state guard (the authority).
      fresh.markDelivered(deliveredAt);
      const saved = await this.fulfillmentRepository.save(fresh, scope);

      // Roll the order up only when EVERY non-`cancelled` fulfillment is now delivered
      // — the just-delivered one is included in this re-read, so the last delivery flips
      // the order. A still-`pending` or still-`shipped` sibling leaves the order as-is.
      const all = await this.fulfillmentRepository.listByOrderId(orderId, scope);
      if (MarkDeliveredUseCase.everyFulfillmentDelivered(all)) {
        const freshOrder = await this.orderRepository.findById(orderId, scope);
        if (!freshOrder) {
          throw new OrderDomainException(
            OrderErrorCodeEnum.ORDER_NOT_FOUND,
            `Order ${orderId} vanished while delivering`,
          );
        }
        freshOrder.markDelivered();
        await this.orderRepository.save(freshOrder, scope);
      }

      return saved;
    });

    // Resolve the buyer's email so the delivery-confirmation consumer has a recipient
    // without a per-delivery RPC (ADR-033). Best-effort: a tombstoned/missing customer or a
    // reader hiccup yields `null` (the helper never throws).
    const customerEmail = await resolveCustomerEmail(
      this.customerContactReader,
      order.customerId,
      this.logger,
      correlationId,
    );

    await this.emitDelivered(delivered, customerEmail, correlationId);

    this.logger.info({ correlationId, orderId, fulfillmentId }, 'Fulfillment delivered');
    return toFulfillmentView(delivered);
  }

  // True iff every non-`cancelled` fulfillment of the order is `delivered`. A cancelled
  // shipment is excluded (it never has to be delivered); a `pending` or `shipped` one
  // makes the order not-yet-fully-delivered. An order with only cancelled fulfillments
  // is not delivered (there is nothing delivered to roll up).
  private static everyFulfillmentDelivered(fulfillments: Fulfillment[]): boolean {
    const live = fulfillments.filter((f) => f.status !== FulfillmentStatusEnum.CANCELLED);
    return live.length > 0 && live.every((f) => f.status === FulfillmentStatusEnum.DELIVERED);
  }

  // Best-effort, post-commit (ADR-020). The delivery has already committed, so a publish
  // failure is warn-logged and swallowed — it never fails the operation. `customerEmail` is
  // the buyer's resolved contact (or `null`); `customerLocale` ships `null` (locale deferred).
  private async emitDelivered(
    fulfillment: Fulfillment,
    customerEmail: string | null,
    correlationId: string,
  ): Promise<void> {
    try {
      await this.publisher.publishFulfillmentDelivered({
        orderId: fulfillment.orderId,
        fulfillmentId: fulfillment.id!,
        customerEmail,
        customerLocale: null,
        deliveredAt: (fulfillment.deliveredAt ?? new Date()).toISOString(),
        eventVersion: 'v1',
        occurredAt: new Date().toISOString(),
        correlationId,
      });
    } catch (error) {
      this.logger.warn(
        { err: error as Error, correlationId, fulfillmentId: fulfillment.id },
        'Failed to publish retail.fulfillment.delivered (delivery already committed)',
      );
    }
  }
}
