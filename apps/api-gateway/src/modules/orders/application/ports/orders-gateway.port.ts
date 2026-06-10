import { IPage, OrderView } from '@retail-inventory-system/contracts';

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

// The gateway-side seam onto the retail microservice's order read + capture RPCs. The
// concrete implementation (`OrdersRabbitmqAdapter`) is the only holder of a
// `ClientProxy`; use cases and the controller depend on this interface (ADR-009).
// `getOrder` / `capturePayment` resolve the retail `OrderView` (surfaced over HTTP
// unchanged); `listMyOrders` resolves an `IPage<OrderView>`.
export interface IOrdersGatewayPort {
  getOrder(query: IOrderGetQuery, correlationId: string): Promise<OrderView>;
  listMyOrders(query: IOrderListQuery, correlationId: string): Promise<IPage<OrderView>>;
  capturePayment(command: IPaymentCaptureCommand, correlationId: string): Promise<OrderView>;
}
