import { FulfillmentView, IPage, OrderView, RefundView } from '@retail-inventory-system/contracts';

export const ORDERS_GATEWAY_PORT = Symbol('ORDERS_GATEWAY_PORT');

// Business-shaped command/query inputs for the gateway orders port. They omit
// `correlationId` — a transport concern threaded separately and stitched onto the
// wire payload inside the adapter (the cart/catalog/inventory gateway split).
//
// **The staff-override flags are computed at the gateway, not here on the wire by
// accident.** The gateway use case reads `@CurrentUser().permissions` and resolves
// `canReadAny` (`order:read`) / `isStaffCapture` (`order:capture`) into a boolean,
// and folds `@CurrentUser().id` into `actorId`. The retail use case is the single
// enforcement point: it owner-checks `order.customerId === actorId` unless the
// override is set (ADR-024 / ADR-028 §7). A customer carries no permissions, so its
// override is always `false` — it can only ever reach its own order.

export interface IOrderGetQuery {
  orderId: number;
  actorId: string;
  canReadAny: boolean;
}

// List My Orders is own-only — the only identity it carries is the resolved
// `customerId`; there is no staff override (an admin all-orders listing is a later
// refinement).
export interface IOrderListQuery {
  customerId: string;
  page: number;
  pageSize: number;
}

export interface IPaymentCaptureCommand {
  orderId: number;
  actorId: string;
  isStaffCapture: boolean;
  amountMinor?: number;
  idempotencyKey?: string;
}

// --- Fulfillment + cancel commands (ADR-031) -------------------------------
//
// The fulfillment write commands carry `isStaffFulfill` (resolved from
// `order:fulfill`); List carries `canReadAny` (`order:read`); the cancel commands
// carry `isStaffCancel` (`order:cancel`). Create/Ship/Deliver are practically
// staff-only — their routes are `@RequiresPermission('order:fulfill')`-gated, so the
// resolved `isStaffFulfill` is always `true` for any caller that reaches them. List
// fulfillments + Cancel Order stay owner-or-staff (no `@RequiresPermission`); Cancel
// Line is staff-only (`@RequiresPermission('order:cancel')`). Either way the staff
// flag is resolved at the gateway and the retail use case is the single enforcement
// point (ADR-024 / ADR-028 §7).

// `retail.fulfillment.create` — plan a shipment of one or more `OrderLine` quantities.
// `stockLocationId` is optional (the retail use case defaults it to `default-warehouse`).
export interface IFulfillmentCreateCommand {
  orderId: number;
  stockLocationId?: string;
  lines: { orderLineId: number; quantity: number }[];
  actorId: string;
  isStaffFulfill: boolean;
}

// `retail.fulfillment.ship` — ship a `pending` fulfillment (ship-triggered capture).
// `idempotencyKey` is accepted + forwarded, not deduped (the cart-state analogue).
export interface IFulfillmentShipCommand {
  orderId: number;
  fulfillmentId: number;
  trackingNumber?: string;
  carrier?: string;
  idempotencyKey?: string;
  actorId: string;
  isStaffFulfill: boolean;
}

// `retail.fulfillment.deliver` — mark a `shipped` fulfillment `delivered`.
export interface IFulfillmentDeliverCommand {
  orderId: number;
  fulfillmentId: number;
  actorId: string;
  isStaffFulfill: boolean;
}

// `retail.fulfillment.list` — list one order's fulfillments newest-first
// (owner-or-staff `order:read` via `canReadAny`).
export interface IFulfillmentListQuery {
  orderId: number;
  actorId: string;
  canReadAny: boolean;
}

// `retail.order.cancel` — cancel a not-yet-shipped order (owner-or-staff `order:cancel`
// via `isStaffCancel`; a customer may cancel its own pending order). `reason` is the
// optional human-supplied cancellation reason.
export interface IOrderCancelCommand {
  orderId: number;
  reason?: string;
  actorId: string;
  isStaffCancel: boolean;
}

// `retail.order.cancel-line` — cancel one `OrderLine`'s unshipped quantity (staff
// `order:cancel` only). Omit `quantity` to cancel all the line's remaining quantity.
export interface IOrderLineCancelCommand {
  orderId: number;
  orderLineId: number;
  quantity?: number;
  actorId: string;
  isStaffCancel: boolean;
}

// --- Refund commands (ADR-032) ---------------------------------------------
//
// The refund routes are order-scoped (`/api/orders/:orderId/refunds`), so they extend the
// orders gateway port. Issue Refund is **staff-only** (`order:refund`), gated with
// `@RequiresPermission` at the route, so its command carries only the resolved `actorId`
// (the staff caller's id, always a real string from the manual endpoint — the
// system-null actor is a retail consumer-only path) + the accepted-but-not-deduped
// `idempotencyKey`. List Refunds is **owner-or-staff** `order:read`: it carries the
// `isStaff` override (resolved from `order:read`) instead of a permission gate.

// `retail.refund.issue` — issue a refund against a captured payment (staff `order:refund`).
// `amountMinor` is the refund amount in integer minor units; the retail use case validates
// it against the refundable ceiling. `reason` is the required human-supplied reason.
export interface IRefundIssueCommand {
  orderId: number;
  paymentId: number;
  amountMinor: number;
  reason: string;
  actorId: string;
  idempotencyKey?: string;
}

// `retail.refund.list` — list an order's refunds newest-first (owner-or-staff `order:read`
// via `isStaff`). A non-owner non-staff caller is `REFUND_ACCESS_FORBIDDEN` (403).
export interface IRefundListQuery {
  orderId: number;
  actorId: string;
  isStaff: boolean;
}

// The gateway-side seam onto the retail microservice's order read + capture +
// fulfillment + cancel + refund RPCs. The concrete implementation (`OrdersRabbitmqAdapter`)
// is the only holder of a `ClientProxy`; use cases and the controllers depend on this
// interface (ADR-009). `getOrder` / `capturePayment` / `cancelOrder` / `cancelLine`
// resolve the retail `OrderView`; `listMyOrders` an `IPage<OrderView>`;
// `createFulfillment` / `shipFulfillment` / `markDelivered` a single `FulfillmentView`;
// `listFulfillments` a `FulfillmentView[]`; `issueRefund` a single `RefundView`;
// `listRefunds` a `RefundView[]`. All are surfaced over HTTP unchanged.
export interface IOrdersGatewayPort {
  getOrder(query: IOrderGetQuery, correlationId: string): Promise<OrderView>;
  listMyOrders(query: IOrderListQuery, correlationId: string): Promise<IPage<OrderView>>;
  capturePayment(command: IPaymentCaptureCommand, correlationId: string): Promise<OrderView>;
  createFulfillment(
    command: IFulfillmentCreateCommand,
    correlationId: string,
  ): Promise<FulfillmentView>;
  shipFulfillment(
    command: IFulfillmentShipCommand,
    correlationId: string,
  ): Promise<FulfillmentView>;
  markDelivered(
    command: IFulfillmentDeliverCommand,
    correlationId: string,
  ): Promise<FulfillmentView>;
  listFulfillments(query: IFulfillmentListQuery, correlationId: string): Promise<FulfillmentView[]>;
  cancelOrder(command: IOrderCancelCommand, correlationId: string): Promise<OrderView>;
  cancelLine(command: IOrderLineCancelCommand, correlationId: string): Promise<OrderView>;
  issueRefund(command: IRefundIssueCommand, correlationId: string): Promise<RefundView>;
  listRefunds(query: IRefundListQuery, correlationId: string): Promise<RefundView[]>;
}
