import { randomUUID } from 'crypto';

import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';

import { bodyFingerprint } from '@retail-inventory-system/common';
import {
  CartStatusEnum,
  IIdempotentResult,
  IPlaceOrderPayload,
  OrderView,
  VariantWithProductView,
} from '@retail-inventory-system/contracts';

import {
  Address,
  Order,
  OrderDomainException,
  OrderErrorCodeEnum,
  OrderLine,
  Payment,
} from '../../domain';
import {
  IIdempotencyStorePort,
  IOrderCartReaderPort,
  IOrderCatalogGatewayPort,
  IOrderCustomerContactReaderPort,
  IOrderEventsPublisherPort,
  IOrderInventoryGatewayPort,
  IOrderRepositoryPort,
  IAddressRepositoryPort,
  IPaymentRepositoryPort,
  ITransactionPort,
  ADDRESS_REPOSITORY,
  IDEMPOTENCY_STORE,
  ORDER_CART_READER,
  ORDER_CATALOG_GATEWAY,
  ORDER_CUSTOMER_CONTACT_READER,
  ORDER_EVENTS_PUBLISHER,
  ORDER_INVENTORY_GATEWAY,
  ORDER_REPOSITORY,
  PAYMENT_REPOSITORY,
  TRANSACTION_PORT,
} from '../ports';
import { AuthorizePaymentUseCase } from './authorize-payment.use-case';
import { toOrderView } from './order-view.factory';
import { resolveCustomerEmail } from './resolve-customer-email';

const PROVISIONAL_ORDER_NUMBER = 'PENDING';

@Injectable()
export class PlaceOrderUseCase {
  constructor(
    @Inject(ORDER_CART_READER)
    private readonly cartReader: IOrderCartReaderPort,
    @Inject(ORDER_CATALOG_GATEWAY)
    private readonly catalog: IOrderCatalogGatewayPort,
    @Inject(ORDER_INVENTORY_GATEWAY)
    private readonly inventory: IOrderInventoryGatewayPort,
    @Inject(ORDER_REPOSITORY)
    private readonly orderRepository: IOrderRepositoryPort,
    @Inject(ADDRESS_REPOSITORY)
    private readonly addressRepository: IAddressRepositoryPort,
    @Inject(PAYMENT_REPOSITORY)
    private readonly paymentRepository: IPaymentRepositoryPort,
    @Inject(TRANSACTION_PORT)
    private readonly transactionPort: ITransactionPort,
    @Inject(ORDER_EVENTS_PUBLISHER)
    private readonly publisher: IOrderEventsPublisherPort,
    @Inject(ORDER_CUSTOMER_CONTACT_READER)
    private readonly customerContactReader: IOrderCustomerContactReaderPort,
    @Inject(IDEMPOTENCY_STORE)
    private readonly idempotencyStore: IIdempotencyStorePort,
    private readonly authorizePayment: AuthorizePaymentUseCase,
    @InjectPinoLogger(PlaceOrderUseCase.name)
    private readonly logger: PinoLogger,
  ) {}

  private static readonly SCOPE = 'place-order';

  public async execute(payload: IPlaceOrderPayload): Promise<IIdempotentResult<OrderView>> {
    const { cartId, idempotencyKey, correlationId } = payload;

    if (!idempotencyKey) {
      throw new OrderDomainException(
        OrderErrorCodeEnum.ORDER_IDEMPOTENCY_KEY_REQUIRED,
        'An Idempotency-Key is required to place an order',
      );
    }

    const fingerprint = bodyFingerprint(PlaceOrderUseCase.canonicalBody(payload));

    const prior = await this.idempotencyStore.find(PlaceOrderUseCase.SCOPE, idempotencyKey);
    if (prior) {
      if (prior.requestFingerprint === fingerprint) {
        this.logger.debug(
          { correlationId, cartId, idempotencyKey },
          'Idempotent replay — returning the stored place response (no re-execution, no events)',
        );
        return { view: prior.responseBody as unknown as OrderView, replayed: true };
      }
      throw new OrderDomainException(
        OrderErrorCodeEnum.ORDER_IDEMPOTENCY_KEY_REUSED,
        `Idempotency-Key ${idempotencyKey} was already used for a place-order request with a different body`,
      );
    }

    const view = await this.place(payload);

    await this.idempotencyStore.save({
      scope: PlaceOrderUseCase.SCOPE,
      key: idempotencyKey,
      requestFingerprint: fingerprint,
      responseStatus: HttpStatus.CREATED,
      responseBody: view as unknown as Record<string, unknown>,
    });

    const stored = await this.idempotencyStore.find(PlaceOrderUseCase.SCOPE, idempotencyKey);
    if (stored && (stored.responseBody as { id?: number }).id !== view.id) {
      this.logger.debug(
        { correlationId, cartId, idempotencyKey },
        'Idempotent replay — a concurrent place stored first; returning the winning order',
      );
      return { view: stored.responseBody as unknown as OrderView, replayed: true };
    }
    return { view, replayed: false };
  }

  private static canonicalBody(payload: IPlaceOrderPayload): Record<string, unknown> {
    return {
      cartId: payload.cartId,
      shippingAddress: payload.shippingAddress,
      billingAddress: payload.billingAddress,
      paymentMethod: payload.paymentMethod,
    };
  }

  private async place(payload: IPlaceOrderPayload): Promise<OrderView> {
    const { cartId, customerId, idempotencyKey, correlationId } = payload;

    this.logger.info({ correlationId, cartId, customerId, idempotencyKey }, 'Placing order');

    const cart = await this.cartReader.findCart(cartId);
    if (!cart) {
      throw new OrderDomainException(
        OrderErrorCodeEnum.ORDER_CART_NOT_FOUND,
        `Cart ${cartId} not found`,
      );
    }
    if (cart.customerId !== customerId) {
      throw new OrderDomainException(
        OrderErrorCodeEnum.ORDER_CART_ACCESS_FORBIDDEN,
        `Cart ${cartId} is not owned by customer ${customerId}`,
      );
    }
    if (cart.status === CartStatusEnum.CONVERTED) {
      return this.resolveExistingOrder(cartId, correlationId);
    }
    if (cart.status === CartStatusEnum.ABANDONED) {
      throw new OrderDomainException(
        OrderErrorCodeEnum.ORDER_CART_NOT_PLACEABLE,
        `Cart ${cartId} is abandoned and cannot be placed`,
      );
    }
    if (cart.lines.length === 0) {
      throw new OrderDomainException(
        OrderErrorCodeEnum.ORDER_CART_EMPTY,
        `Cart ${cartId} is empty; nothing to place`,
      );
    }

    const lines = await this.snapshotLines(cart.lines, cart.currency, correlationId);

    const placedAt = new Date();
    const allocationLines = lines.map((line) => ({
      variantId: line.variantId,
      quantity: line.quantity,
    }));
    let allocated = false;
    let allocatedOrderId: number | null = null;

    let saved: Order;
    try {
      saved = await this.transactionPort.runInTransaction(async (scope) => {
        const order = Order.place({
          orderNumber: PROVISIONAL_ORDER_NUMBER,
          customerId,
          currency: cart.currency,
          lines,
          billingAddressId: null,
          shippingAddressId: null,
          sourceCartId: cartId,
          placedAt,
        });
        const persisted = await this.orderRepository.save(order, scope);
        const orderId = persisted.id!;

        const billing = Address.forOrder({ orderId: String(orderId), ...payload.billingAddress });
        const shipping = Address.forOrder({ orderId: String(orderId), ...payload.shippingAddress });
        await this.addressRepository.save(billing, scope);
        await this.addressRepository.save(shipping, scope);
        await this.orderRepository.attachAddresses(orderId, billing.id!, shipping.id!, scope);

        const converted = await this.cartReader.markConverted(cartId, scope);
        if (!converted) {
          throw new OrderDomainException(
            OrderErrorCodeEnum.ORDER_CART_NOT_PLACEABLE,
            `Cart ${cartId} was converted or abandoned concurrently; place aborted`,
          );
        }

        await this.inventory.allocateStock({
          cartId,
          orderId,
          lines: allocationLines,
          correlationId,
        });
        allocated = true;
        allocatedOrderId = orderId;
        return persisted;
      });
    } catch (err) {
      if (allocated && allocatedOrderId !== null) {
        try {
          await this.inventory.cancelAllocation({
            orderId: allocatedOrderId,
            lines: allocationLines,
            operationKey: randomUUID(),
            reason: 'place-rollback',
            correlationId,
          });
        } catch (cancelErr) {
          this.logger.warn(
            { err: cancelErr as Error, correlationId, cartId, orderId: allocatedOrderId },
            'Failed to compensate allocation after a post-allocate place failure (stock left allocated)',
          );
        }
      }
      throw err;
    }

    const orderId = saved.id!;

    let payment: Payment;
    try {
      payment = await this.authorizePayment.execute({
        orderId,
        amountMinor: saved.grandTotalMinor,
        currency: saved.currency,
        method: payload.paymentMethod,
        correlationId,
      });
    } catch (err) {
      await this.compensateDeclinedAuthorization(orderId, allocationLines, correlationId);
      throw err;
    }

    const finalOrder = await this.orderRepository.findById(orderId);
    if (!finalOrder) {
      throw new Error(`PlaceOrderUseCase: order ${orderId} vanished after place`);
    }

    await this.emitEvents(finalOrder, payment, placedAt, idempotencyKey, correlationId);

    this.logger.info(
      { correlationId, orderId, orderNumber: finalOrder.orderNumber, idempotencyKey },
      'Order placed and payment authorized',
    );
    return toOrderView(finalOrder, payment);
  }

  private async compensateDeclinedAuthorization(
    orderId: number,
    allocationLines: { variantId: number; quantity: number }[],
    correlationId: string,
  ): Promise<void> {
    try {
      await this.inventory.cancelAllocation({
        orderId,
        lines: allocationLines,
        operationKey: randomUUID(),
        reason: 'authorization-declined',
        correlationId,
      });
    } catch (cancelErr) {
      this.logger.error(
        { err: cancelErr as Error, correlationId, orderId },
        'Failed to release the allocation of a declined order — stock is held for an order that can never ship',
      );
    }

    try {
      await this.transactionPort.runInTransaction(async (scope) => {
        const fresh = await this.orderRepository.findById(orderId, scope);
        if (!fresh) {
          throw new Error(`Order ${orderId} vanished while compensating a declined authorization`);
        }
        const versionAtLoad = fresh.version;
        fresh.markPaymentFailed();
        fresh.cancel();
        await this.orderRepository.save(fresh, scope, versionAtLoad);
      });
    } catch (markErr) {
      this.logger.error(
        { err: markErr as Error, correlationId, orderId },
        'Failed to mark a declined order payment-failed — it will read as a live pending order',
      );
    }
  }

  private async resolveExistingOrder(cartId: string, correlationId: string): Promise<OrderView> {
    const existing = await this.orderRepository.findBySourceCartId(cartId);
    if (!existing) {
      throw new Error(`Cart ${cartId} is converted but has no order`);
    }
    const payment = await this.paymentRepository.findByOrderId(existing.id!);
    if (!payment) {
      this.logger.warn(
        { correlationId, cartId, orderId: existing.id, orderStatus: existing.status },
        'Repeat place on a cart whose order was never paid for — refusing rather than reporting success',
      );
      throw new OrderDomainException(
        OrderErrorCodeEnum.ORDER_PAYMENT_NOT_APPROVED,
        `Cart ${cartId} was placed as order ${existing.orderNumber}, but its payment was not approved. ` +
          'The cart cannot be reused; start a new one.',
      );
    }
    this.logger.info(
      { correlationId, cartId, orderId: existing.id, orderNumber: existing.orderNumber },
      'Repeat place — returning the existing order (cart already converted)',
    );
    return toOrderView(existing, payment);
  }

  private async snapshotLines(
    cartLines: { variantId: number; quantity: number }[],
    currency: string,
    correlationId: string,
  ): Promise<OrderLine[]> {
    return Promise.all(
      cartLines.map(async (cartLine) => {
        const [variant, price] = await Promise.all([
          this.catalog.getVariant(cartLine.variantId, correlationId),
          this.catalog.selectApplicablePrice(cartLine.variantId, currency, correlationId),
        ]);
        if (price === null) {
          throw new OrderDomainException(
            OrderErrorCodeEnum.ORDER_LINE_NO_PRICE,
            `Variant ${cartLine.variantId} has no applicable ${currency} price; cannot place`,
          );
        }
        return new OrderLine({
          id: null,
          variantId: cartLine.variantId,
          sku: variant.sku,
          nameSnapshot: PlaceOrderUseCase.composeName(variant),
          quantity: cartLine.quantity,
          unitPriceMinor: price.amountMinor,
          taxAmountMinor: 0,
          discountAmountMinor: 0,
        });
      }),
    );
  }

  private static composeName(variant: VariantWithProductView): string {
    const base = variant.product.name;
    const entries = Object.entries(variant.optionValues ?? {});
    if (entries.length === 0) {
      return base;
    }
    const suffix = entries
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, value]) => `${key}: ${value}`)
      .join(', ');
    return `${base} (${suffix})`;
  }

  private async emitEvents(
    order: Order,
    payment: Payment,
    placedAt: Date,
    idempotencyKey: string | undefined,
    correlationId: string,
  ): Promise<void> {
    const occurredAt = placedAt.toISOString();
    const orderId = order.id!;

    const customerEmail = await resolveCustomerEmail(
      this.customerContactReader,
      order.customerId,
      this.logger,
      correlationId,
    );

    try {
      await this.publisher.publishOrderPlaced({
        orderId,
        orderNumber: order.orderNumber,
        customerId: order.customerId,
        customerEmail,
        customerLocale: null,
        grandTotalMinor: order.grandTotalMinor,
        currency: order.currency,
        lineCount: order.lines.length,
        eventVersion: 'v1',
        occurredAt,
        correlationId,
      });
    } catch (error) {
      this.logger.warn(
        { err: error as Error, correlationId, orderId, idempotencyKey },
        'Failed to publish retail.order.placed (order already committed)',
      );
    }

    try {
      await this.publisher.publishPaymentAuthorized({
        orderId,
        paymentId: payment.id!,
        amountMinor: payment.amountMinor,
        currency: payment.currency,
        eventVersion: 'v1',
        occurredAt,
        correlationId,
      });
    } catch (error) {
      this.logger.warn(
        { err: error as Error, correlationId, orderId, idempotencyKey },
        'Failed to publish retail.payment.authorized (order already committed)',
      );
    }
  }
}
