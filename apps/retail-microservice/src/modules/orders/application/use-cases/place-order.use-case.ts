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

// The repository overwrites `order_number` with the id-derived binding value on the
// first insert (`ORD-<year>-<pad8(id)>`), so the value passed to `Order.place` is a
// throwaway the buyer never sees — the re-read `saved` order carries the real number.
const PROVISIONAL_ORDER_NUMBER = 'PENDING';

// Place Order: convert an `active` cart into an immutable `Order` one-shot (ADR-028
// §1). It snapshots each line from the catalog at write-time (`sku` / `nameSnapshot`
// via `catalog.variant.get`, `unitPriceMinor` via `catalog.price.select` — ADR-025
// / ADR-026), snapshots the buyer's billing + shipping addresses as immutable
// `ownerType=order` copies (ADR-028 §5), allocates the cart's stock holds into the
// order **inside the place transaction, after the cart-conversion CAS** (ADR-030 —
// reserved → allocated, or a direct allocation fallback), authorizes payment inline
// via the `PAYMENT_GATEWAY` (authorize-on-place), and emits `retail.order.placed` +
// `retail.payment.authorized` post-commit.
//
// **Allocate precedes payment, so money is never authorized for stock that could not be
// allocated. The inverse does NOT hold.** The authorize runs *after* the place transaction has
// committed, and nothing compensates a decline: the order row, the `converted` cart and the stock
// allocation all survive it. The result is an order that can never ship (Ship refuses an order with
// no payment) and stock allocated against it indefinitely. A known, unfixed gap — the bound gateway
// always approves, so it is latent. **Do not read the guarantee above as symmetric.**
//
// **The snapshot is the contract with the buyer.** A later catalog/price/name change
// must never rewrite a placed order, so the line freezes the catalog values at
// place-time rather than referencing the live catalog row.
//
// **Repeat-place idempotency has two layers (ADR-036).** First the request-level
// `Idempotency-Key`: `execute` fingerprints the canonical body (`bodyFingerprint`),
// looks the `(scope='place-order', key)` pair up in the `IDEMPOTENCY_STORE`, and on a
// same-key/same-body hit **replays the stored `OrderView` before any side effect** —
// no inventory, no payment, no `emitEvents` (a replay must be side-effect-free beyond
// returning the original response). A same-key/*different*-body hit is a client
// key-reuse bug → `422`; a missing key is a `400` backstop (the gateway enforces the
// header at the edge). On a store miss the place runs, and its `OrderView` is persisted
// (outside the transaction — the view is only complete after payment authorization) so
// the next identical retry replays. Second, cart state remains the **durable** backstop
// (ADR-028 §6): a placed cart is `converted`, so a re-place with a *new* key returns the
// order it already converted into (via `source_cart_id`) — this survives even a lost
// idempotency record. Key-store first; on a miss the converted-cart guard still applies.
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

  // The scope namespaces the client key by operation, so the same `Idempotency-Key`
  // reused for a place and (later) a capture cannot collide in the store (ADR-036).
  private static readonly SCOPE = 'place-order';

  public async execute(payload: IPlaceOrderPayload): Promise<IIdempotentResult<OrderView>> {
    const { cartId, idempotencyKey, correlationId } = payload;

    // Defensive backstop for the gateway's required-header edge check: the header is an
    // HTTP concern the gateway rejects with `IDEMPOTENCY_KEY_REQUIRED`, but a direct RMQ
    // caller that bypassed the gateway still fails fast here (ADR-036).
    if (!idempotencyKey) {
      throw new OrderDomainException(
        OrderErrorCodeEnum.ORDER_IDEMPOTENCY_KEY_REQUIRED,
        'An Idempotency-Key is required to place an order',
      );
    }

    // Fingerprint the CANONICAL body — the client-controlled place command minus
    // transport/identity noise (`correlationId`, `idempotencyKey`, and the
    // owner-injected `customerId`), so a retry under a fresh correlation id still
    // matches (ADR-036, the "what the body is" rule).
    const fingerprint = bodyFingerprint(PlaceOrderUseCase.canonicalBody(payload));

    // 1. Key-store lookup FIRST. A hit with a matching fingerprint is a replay: return
    //    the stored `OrderView` WITHOUT touching inventory/payment and WITHOUT
    //    re-emitting events — this branch returns before `place`, which owns the whole
    //    place flow including `emitEvents`. A hit with a different fingerprint is one key
    //    reused for a different body → 422.
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

    // 2. Miss — run the place flow (the converted-cart backstop still applies inside).
    const view = await this.place(payload);

    // 3. Persist the stored response OUTSIDE the place transaction: the `OrderView` is
    //    only complete after payment authorization + the re-read (both post-commit).
    //    `save` swallows a concurrent duplicate-PK insert (a simultaneous identical place
    //    that committed first), so the authoritative re-read below converges both racers
    //    on ONE order.
    await this.idempotencyStore.save({
      scope: PlaceOrderUseCase.SCOPE,
      key: idempotencyKey,
      requestFingerprint: fingerprint,
      // The place route is `201 Created`; a replay downgrades to `200` at the gateway.
      responseStatus: HttpStatus.CREATED,
      responseBody: view as unknown as Record<string, unknown>,
    });

    const stored = await this.idempotencyStore.find(PlaceOrderUseCase.SCOPE, idempotencyKey);
    if (stored && (stored.responseBody as { id?: number }).id !== view.id) {
      // Our `save` lost the composite-PK race to a concurrent identical place; return the
      // winner's stored order so both racers converge on one response. There is no second
      // order in production — the cart-conversion CAS already guarantees exactly one
      // order was ever created for the cart (the CAS-loses guard inside `place`).
      this.logger.debug(
        { correlationId, cartId, idempotencyKey },
        'Idempotent replay — a concurrent place stored first; returning the winning order',
      );
      return { view: stored.responseBody as unknown as OrderView, replayed: true };
    }
    return { view, replayed: false };
  }

  // Builds the stable logical body the fingerprint covers: the client-controlled place
  // command only. `correlationId` / `idempotencyKey` (transport + the dedup anchor) and
  // the owner-injected `customerId` (a session property, not request content) are
  // excluded, so the same intent under a fresh correlation id fingerprints identically
  // (ADR-036). The gateway and this service must hash the same logical object to agree.
  private static canonicalBody(payload: IPlaceOrderPayload): Record<string, unknown> {
    return {
      cartId: payload.cartId,
      shippingAddress: payload.shippingAddress,
      billingAddress: payload.billingAddress,
      paymentMethod: payload.paymentMethod,
    };
  }

  // The place flow proper (run on a store miss): owner + state guard, catalog snapshot,
  // the one-transaction persist + allocate, inline payment authorization, and the
  // post-commit events. Returns the `OrderView`; a `converted` cart short-circuits to the
  // already-placed order (the durable cart-state backstop — no allocate, no payment, no
  // events).
  private async place(payload: IPlaceOrderPayload): Promise<OrderView> {
    const { cartId, customerId, idempotencyKey, correlationId } = payload;

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
      // Repeat-place idempotency: the cart already converted, so return the order it converted into
      // rather than minting a second one.
      //
      // **`converted` does NOT mean "paid".** The CAS that sets it runs inside the place
      // transaction, and the authorization runs after that transaction commits — so a cart can be
      // converted against an order whose payment was declined. This branch will hand that order
      // back as a success, with `payment: undefined`. See the note in this file's header.
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

    // 3. Build + persist the order, the two snapshot addresses, the cart
    //    conversion, and the stock allocation in one transaction.
    const placedAt = new Date();
    // The allocation lines snapshot — reused by the in-tx allocate AND the
    // post-failure compensation cancel, so both reference the same lines.
    const allocationLines = lines.map((line) => ({
      variantId: line.variantId,
      quantity: line.quantity,
    }));
    // Tracked across the tx boundary: `allocated` flips true only once the
    // allocate RPC resolves (the allocation committed inventory-side), so the
    // compensation fires only for the rare "allocated then the place commit
    // failed" case — never for an allocate rejection (which inventory already
    // rolled back itself).
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

        // Allocate AFTER the conversion CAS succeeds — the final step before the
        // callback returns (ADR-030). Allocate-after-CAS means a concurrent
        // double-place loser threw on the CAS above and never reaches here, so
        // there is no double allocation to unwind. Per line the inventory service
        // commits the active hold (reserved → allocated) or falls back to a direct
        // allocation; an out-of-stock fallback rejects with `INVENTORY_OUT_OF_STOCK`
        // and the rejection propagates out of this callback → the whole place rolls
        // back (no order row, no conversion, the cart stays `active` and fixable),
        // and the typed code + `details.available` reach the gateway. Holding the
        // DB tx across this in-cluster RPC is accepted and bounded: the inventory
        // handler runs its own short transaction on DISJOINT tables of the one
        // shared MySQL, so there is no lock interplay (ADR-030).
        await this.inventory.allocateStock({
          cartId,
          orderId,
          lines: allocationLines,
          correlationId,
        });
        // The allocation committed inventory-side. From here **inside this callback** only the
        // commit can still fail, and the `catch` below compensates that. **The authorize, which
        // runs after this transaction returns, can also fail — and nothing compensates that one.**
        allocated = true;
        allocatedOrderId = orderId;
        return persisted;
      });
    } catch (err) {
      // Compensation for the rare "allocated then the place commit failed" case:
      // the allocation committed in inventory's own transaction, but this place tx
      // then failed at commit, so the counters are left allocated for an order that
      // never persisted. Best-effort cancel the orphaned allocation (its own RPC
      // into inventory's own tx, OUTSIDE this failed transaction), then rethrow the
      // original error so the caller still sees the place failure. `allocated`
      // stays false for an allocate rejection, so nothing is unwound there.
      if (allocated && allocatedOrderId !== null) {
        try {
          await this.inventory.cancelAllocation({
            orderId: allocatedOrderId,
            lines: allocationLines,
            // A free-string movement `reason_code` recording WHY the allocation was
            // unwound (the default is `order-cancelled`); `place-rollback` keeps the
            // ledger honest about a compensation vs a genuine cancel.
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
  // **This returns whatever order the cart converted into, paid or not.** `payment` is `null` when
  // the authorize declined after the place committed — and the resulting `OrderView` still reads as
  // a successful placement. It is the honest answer to "what did this cart become", and the wrong
  // answer to "did my order go through".
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

    // Resolve the buyer's email so the order-confirmation consumer has a recipient without
    // a per-delivery RPC (ADR-033). Best-effort: a tombstoned/missing customer or a reader
    // hiccup yields `null` (the helper never throws). `customerLocale` ships `null` (locale
    // resolution deferred).
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
