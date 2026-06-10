import { ICorrelationPayload } from '../../microservices';

// Wire-format command payloads for the order read + capture RPCs (API Gateway →
// Retail). Each extends `ICorrelationPayload` so the correlation id threads through
// to the retail handler's inline logging (ADR-001 / ADR-011). They are the single
// source of truth for both ends: the gateway `OrdersRabbitmqAdapter` sends them and
// the retail order use cases consume them as their `execute(payload)` input, so a
// drift fails TypeScript on both sides (the contract test).
//
// **Authorization is split across the boundary (ADR-024 / ADR-028 §7).** The customer
// is never permission-gated for its own orders — the route is bearer-protected and
// the retail use case owner-checks `order.customerId === actorId`. The staff override
// is computed at the gateway from `@CurrentUser().permissions` and forwarded here as
// a boolean (`canReadAny` for `order:read`, `isStaffCapture` for `order:capture`), so
// the retail use case never re-reads the permission registry — it trusts the resolved
// flag. `actorId` is the resolved caller (`@CurrentUser().id`).

// `retail.order.get` — reads one order by id (owner-checked, or a staff `order:read`
// override via `canReadAny`).
export interface IRetailOrderGetPayload extends ICorrelationPayload {
  orderId: number;
  actorId: string;
  canReadAny: boolean;
}

// `retail.order.list` — lists the caller's own orders, newest-first, paginated. There
// is no staff-override here: List My Orders is own-only (an admin all-orders listing
// is a later refinement), so the only identity it carries is `customerId`. `page` is
// 1-based; `pageSize` is clamped to a sane ceiling by the use case.
export interface IRetailOrderListPayload extends ICorrelationPayload {
  customerId: string;
  page: number;
  pageSize: number;
}

// `retail.payment.capture` — captures the order's authorized payment (owner-checked,
// or a staff `order:capture` override via `isStaffCapture`). `amountMinor` is optional
// and defaults to the order's `grandTotalMinor` (partial capture is a later
// capability). `idempotencyKey` is **accepted + logged but not deduped** (Q10) —
// re-capturing an already-`captured` payment is idempotent by payment state, returning
// the current state rather than erroring.
export interface IRetailPaymentCapturePayload extends ICorrelationPayload {
  orderId: number;
  actorId: string;
  isStaffCapture: boolean;
  amountMinor?: number;
  idempotencyKey?: string;
}
