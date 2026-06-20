import {
  ReturnDispositionEnum,
  ReturnLineConditionEnum,
  ReturnReasonCategoryEnum,
  ReturnRequestView,
} from '@retail-inventory-system/contracts';

export const RETURNS_GATEWAY_PORT = Symbol('RETURNS_GATEWAY_PORT');

// Business-shaped command/query inputs for the gateway returns port. They omit
// `correlationId` — a transport concern threaded separately and stitched onto the wire
// payload inside the adapter (the orders/cart/inventory gateway split, ADR-009).
//
// **The owner-or-staff override is computed at the gateway, never trusted from the
// wire.** The gateway use case reads `@CurrentUser().permissions` and resolves the staff
// override into a boolean (`isStaff` from `order:return-authorize` for Open, `isStaff`
// from `order:read` for the reads), then folds `@CurrentUser().id` into `customerId` /
// `actorId`. The retail return use case is the single enforcement point: it owner-checks
// `order.customerId === customerId` unless the override is set (ADR-024 / ADR-028 §7). A
// customer carries no permissions, so its override is always `false` — it can only ever
// reach its own order's RMAs. The status-walk commands (authorize/reject/receive/
// inspect/close) are staff-gated at the gateway route with `@RequiresPermission`, so they
// carry no owner-check flag — only `actorId` for the audit/restock attribution.

// `retail.return.open` — open a return request for an order (owner-or-staff
// `order:return-authorize`). `customerId` is the authenticated principal (the buyer on
// the owner path); `isStaff` is the resolved override. `lines` carry the per-`OrderLine`
// quantities being returned; `notes` an optional buyer note.
export interface IOpenReturnCommand {
  orderId: number;
  customerId: string;
  isStaff: boolean;
  reasonCategory: ReturnReasonCategoryEnum;
  notes?: string;
  lines: { orderLineId: number; quantity: number }[];
}

// `retail.return.authorize` — walk a `requested` RMA → `authorized` (staff
// `order:return-authorize`). Staff-gated, so no owner-check flag; `actorId` is the
// resolved caller.
export interface IAuthorizeReturnCommand {
  rmaId: number;
  actorId: string;
}

// `retail.return.reject` — walk a `requested` RMA → `rejected` (staff
// `order:return-authorize`). `reason` is appended to the RMA's `notes` on the retail
// side (no schema change). `actorId` is the resolved caller.
export interface IRejectReturnCommand {
  rmaId: number;
  reason?: string;
  actorId: string;
}

// `retail.return.receive` — walk an `authorized` RMA → `received` (warehouse
// `inventory:receive-return`). Staff-gated; `actorId` is the resolved caller.
export interface IReceiveReturnCommand {
  rmaId: number;
  actorId: string;
}

// `retail.return.inspect` — walk a `received` RMA → `inspected` (warehouse
// `inventory:receive-return`). Staff-gated; `actorId` rides the restock RPC's audit row.
// `lines` carries one entry per RMA line (the retail use case requires a complete
// inspection); only `restock`-disposition lines re-enter sellable inventory.
export interface IInspectReturnCommand {
  rmaId: number;
  actorId: string;
  lines: {
    returnLineId: number;
    condition: ReturnLineConditionEnum;
    disposition: ReturnDispositionEnum;
    lineRefundAmountMinor: number;
  }[];
}

// `retail.return.close` — walk an `inspected` RMA → `closed` (staff
// `order:return-authorize`). Staff-gated; `actorId` is the resolved caller.
export interface ICloseReturnCommand {
  rmaId: number;
  actorId: string;
}

// `retail.return.get` — read one RMA by id (owner-or-staff `order:read` via `isStaff`).
// `actorId` is the resolved caller (the buyer on the owner path).
export interface IGetReturnQuery {
  rmaId: number;
  actorId: string;
  isStaff: boolean;
}

// `retail.return.list` — list one order's RMAs newest-first (owner-or-staff `order:read`
// via `isStaff`; a non-staff caller is filtered to its own RMAs, no existence leak).
export interface IListOrderReturnsQuery {
  orderId: number;
  actorId: string;
  isStaff: boolean;
}

// The gateway-side seam onto the retail microservice's eight return-lifecycle RPCs. The
// concrete implementation (`ReturnsRabbitmqAdapter`) is the only holder of a
// `ClientProxy`; the use cases and controller depend on this interface (ADR-009). Every
// status-walk + Open resolves a single `ReturnRequestView`; `listOrderReturns` a
// `ReturnRequestView[]`. All are surfaced over HTTP unchanged.
export interface IReturnsGatewayPort {
  openReturn(command: IOpenReturnCommand, correlationId: string): Promise<ReturnRequestView>;
  authorizeReturn(
    command: IAuthorizeReturnCommand,
    correlationId: string,
  ): Promise<ReturnRequestView>;
  rejectReturn(command: IRejectReturnCommand, correlationId: string): Promise<ReturnRequestView>;
  receiveReturn(command: IReceiveReturnCommand, correlationId: string): Promise<ReturnRequestView>;
  inspectReturn(command: IInspectReturnCommand, correlationId: string): Promise<ReturnRequestView>;
  closeReturn(command: ICloseReturnCommand, correlationId: string): Promise<ReturnRequestView>;
  getReturn(query: IGetReturnQuery, correlationId: string): Promise<ReturnRequestView>;
  listOrderReturns(
    query: IListOrderReturnsQuery,
    correlationId: string,
  ): Promise<ReturnRequestView[]>;
}
