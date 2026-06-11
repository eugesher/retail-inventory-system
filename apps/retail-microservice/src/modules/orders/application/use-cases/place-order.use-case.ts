import { Inject, Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';

import {
  CartStatusEnum,
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
  IOrderCartReaderPort,
  IOrderCatalogGatewayPort,
  IOrderEventsPublisherPort,
  IOrderRepositoryPort,
  IAddressRepositoryPort,
  IPaymentRepositoryPort,
  ITransactionPort,
  ADDRESS_REPOSITORY,
  ORDER_CART_READER,
  ORDER_CATALOG_GATEWAY,
  ORDER_EVENTS_PUBLISHER,
  ORDER_REPOSITORY,
  PAYMENT_REPOSITORY,
  TRANSACTION_PORT,
} from '../ports';
import { AuthorizePaymentUseCase } from './authorize-payment.use-case';
import { toOrderView } from './order-view.factory';

// The repository overwrites `order_number` with the id-derived binding value on the
// first insert (`ORD-<year>-<pad8(id)>`), so the value passed to `Order.place` is a
// throwaway the buyer never sees — the re-read `saved` order carries the real number.
const PROVISIONAL_ORDER_NUMBER = 'PENDING';

// Place Order: convert an `active` cart into an immutable `Order` one-shot (ADR-028
// §1). It snapshots each line from the catalog at write-time (`sku` / `nameSnapshot`
// via `catalog.variant.get`, `unitPriceMinor` via `catalog.price.select` — ADR-025
// / ADR-026), snapshots the buyer's billing + shipping addresses as immutable
// `ownerType=order` copies (ADR-028 §5), authorizes payment inline via the
// `PAYMENT_GATEWAY` (authorize-on-place, Q5), and emits `retail.order.placed` +
// `retail.payment.authorized` post-commit.
//
// **The snapshot is the contract with the buyer.** A later catalog/price/name change
// must never rewrite a placed order, so the line freezes the catalog values at
// place-time rather than referencing the live catalog row.
//
// **Repeat-place idempotency is driven by cart state, not the `Idempotency-Key`**
// (Q10 / ADR-028 §6): a placed cart is `converted`; re-placing it returns the order
// it already converted into (via `source_cart_id`) rather than creating a second
// order. The `Idempotency-Key` header is accepted + logged but NOT deduped in this
// capability (a persisted idempotency store is a later capability).
@Injectable()
export class PlaceOrderUseCase {
  constructor(
    @Inject(ORDER_CART_READER)
    private readonly cartReader: IOrderCartReaderPort,
    @Inject(ORDER_CATALOG_GATEWAY)
    private readonly catalog: IOrderCatalogGatewayPort,
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
    private readonly authorizePayment: AuthorizePaymentUseCase,
    @InjectPinoLogger(PlaceOrderUseCase.name)
    private readonly logger: PinoLogger,
  ) {}

  public async execute(payload: IPlaceOrderPayload): Promise<OrderView> {
    const { cartId, customerId, idempotencyKey, correlationId } = payload;

    // Q10: the `Idempotency-Key` is accepted + logged but NOT deduped here.
    this.logger.info({ correlationId, cartId, customerId, idempotencyKey }, 'Placing order');

    // 1. Owner + state guard.
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
      // Repeat-place idempotency: the cart already converted, so return the order it
      // converted into (plus its payment) instead of placing a second one.
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

    // 2. Snapshot the lines from the catalog (read-only, no transaction).
    const lines = await this.snapshotLines(cart.lines, cart.currency, correlationId);

    // 3. Build + persist the order, the two snapshot addresses, and the cart
    //    conversion in one transaction.
    const placedAt = new Date();
    const saved = await this.transactionPort.runInTransaction(async (scope) => {
      const order = Order.place({
        orderNumber: PROVISIONAL_ORDER_NUMBER,
        customerId,
        currency: cart.currency,
        lines,
        // Inserted NULL, then patched once the address rows exist (they FK onto
        // `address`, so the order row precedes the pointer — ADR-028 §5).
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
        // The compare-and-swap matched no `active` row: a concurrent place
        // converted (or a purge abandoned) this cart between the state guard and
        // here. Throwing rolls this transaction back — without it both racers
        // would commit, minting two orders (and two authorized payments) from one
        // cart. The loser surfaces a 409; a retry resolves the winner's order via
        // the converted-cart idempotency path.
        throw new OrderDomainException(
          OrderErrorCodeEnum.ORDER_CART_NOT_PLACEABLE,
          `Cart ${cartId} was converted or abandoned concurrently; place aborted`,
        );
      }
      return persisted;
    });

    const orderId = saved.id!;

    // 4. Authorize payment inline (the out-of-process gateway call runs outside the
    //    DB transaction; the Payment + paymentStatus advance commit in a short
    //    follow-up transaction inside the authorize use case).
    const payment = await this.authorizePayment.execute({
      orderId,
      amountMinor: saved.grandTotalMinor,
      currency: saved.currency,
      method: payload.paymentMethod,
      correlationId,
    });

    // Re-read the order so the view carries the attached addresses + the advanced
    // `paymentStatus`.
    const finalOrder = await this.orderRepository.findById(orderId);
    if (!finalOrder) {
      throw new Error(`PlaceOrderUseCase: order ${orderId} vanished after place`);
    }

    // 5. Emit the post-commit events (best-effort, ADR-020).
    await this.emitEvents(finalOrder, payment, placedAt, idempotencyKey, correlationId);

    this.logger.info(
      { correlationId, orderId, orderNumber: finalOrder.orderNumber, idempotencyKey },
      'Order placed and payment authorized',
    );
    return toOrderView(finalOrder, payment);
  }

  // The repeat-place path: a converted cart resolves to the order it converted into.
  private async resolveExistingOrder(cartId: string, correlationId: string): Promise<OrderView> {
    const existing = await this.orderRepository.findBySourceCartId(cartId);
    if (!existing) {
      // A converted cart with no order is an invariant breach — a half-committed
      // place. Surfaced as a 500 (a plain Error has no domain code).
      throw new Error(`Cart ${cartId} is converted but has no order`);
    }
    const payment = await this.paymentRepository.findByOrderId(existing.id!);
    this.logger.info(
      { correlationId, cartId, orderId: existing.id, orderNumber: existing.orderNumber },
      'Repeat place — returning the existing order (cart already converted)',
    );
    return toOrderView(existing, payment);
  }

  // Snapshots each cart line from the catalog at place-time. Per line it fetches the
  // variant header (`sku` + the composed `nameSnapshot`) and the applicable price;
  // a variant with no applicable price in the cart's currency is rejected (the line
  // cannot be priced — `ORDER_LINE_NO_PRICE`, 409). tax/discount are 0 (no
  // tax/discount capability — the tax category is a label only, ADR-026), so
  // `lineTotalMinor = unitPriceMinor × quantity`.
  private async snapshotLines(
    cartLines: { variantId: number; quantity: number }[],
    currency: string,
    correlationId: string,
  ): Promise<OrderLine[]> {
    // The per-line snapshots are independent, read-only catalog lookups that run
    // before the place transaction, so fan them out concurrently rather than walking
    // the cart serially — an N-line cart costs one round-trip's latency, not N.
    // `Promise.all` preserves cart-line order, and the unpriced-variant rejection
    // still propagates (as the first rejected promise).
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

  // Composes the line's frozen display name from the product name + the variant's
  // option values, e.g. `Aurora Desk Lamp (color: warm-white)` — a richer snapshot
  // than the bare product name, so the placed line reads like the storefront did at
  // purchase. Keys are sorted for a deterministic string; a variant with no option
  // values snapshots the plain product name.
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

  // Best-effort, post-commit (ADR-020). The order write has already committed, so a
  // publish failure is warn-logged and swallowed — it never fails the place. The two
  // emits are independent, each swallowing its own failure.
  private async emitEvents(
    order: Order,
    payment: Payment,
    placedAt: Date,
    idempotencyKey: string | undefined,
    correlationId: string,
  ): Promise<void> {
    const occurredAt = placedAt.toISOString();
    const orderId = order.id!;

    try {
      await this.publisher.publishOrderPlaced({
        orderId,
        orderNumber: order.orderNumber,
        customerId: order.customerId,
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
