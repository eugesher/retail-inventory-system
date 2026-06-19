import { ICorrelationPayload } from '../../microservices';
import { ReturnReasonCategoryEnum } from '../enums';

// Wire-format command payloads for the return (RMA) RPCs (API Gateway → Retail, served
// by the returns controller — the returns bounded context is its own module, ADR-032).
// Each extends `ICorrelationPayload` so the correlation id threads through to the retail
// handler's inline logging (ADR-001 / ADR-011). They are the single source of truth for
// both ends: the gateway adapter sends them and the retail return use cases consume them
// as their `execute(payload)` input, so a drift fails TypeScript on both sides (the
// contract test).
//
// **Authorization is split across the boundary (ADR-024 / ADR-028 §7).** Open + the reads
// are **owner-or-staff**: the route is bearer-protected, the gateway folds the
// authenticated principal into `customerId` / `actorId` and resolves the staff override
// from `@CurrentUser().permissions` into a boolean (`isStaff` for `order:return-authorize`
// on Open, `isStaff` for `order:read` on the reads), and the retail use case owner-checks
// (`order.customerId === customerId`) unless the staff flag is set — it never re-reads the
// permission registry. The status-walk commands (authorize / reject / receive / close) are
// **staff-gated at the gateway** with `@RequiresPermission`, so they carry no owner-check
// flag — only `actorId` for audit/logging.

// `retail.return.open` — opens a return request (owner-or-staff `order:return-authorize`).
// The use case reads the order through the raw-SQL reader, enforces the return-window +
// returnable-quantity invariants, and (on success) finalizes an `RMA-<year>-<pad8(id)>`
// number. `customerId` is the authenticated principal (the buyer for the owner path);
// `isStaff` is the resolved `order:return-authorize` override. `lines` carry the
// per-`OrderLine` quantities being returned; `notes` is an optional buyer note.
export interface IRetailReturnOpenPayload extends ICorrelationPayload {
  orderId: number;
  customerId: string;
  isStaff: boolean;
  reasonCategory: ReturnReasonCategoryEnum;
  notes?: string;
  lines: { orderLineId: number; quantity: number }[];
}

// `retail.return.authorize` — walks a `requested` RMA → `authorized` (staff
// `order:return-authorize`). Staff-gated at the gateway, so it carries no owner-check
// flag; `actorId` is the resolved caller for audit/logging.
export interface IRetailReturnAuthorizePayload extends ICorrelationPayload {
  rmaId: number;
  actorId: string;
}

// `retail.return.reject` — walks a `requested` RMA → `rejected` (staff
// `order:return-authorize`). `reason` is the optional rejection reason (appended to the
// RMA's `notes` so no schema change is needed — recorded on the `retail.return.rejected`
// event too). `actorId` is the resolved caller.
export interface IRetailReturnRejectPayload extends ICorrelationPayload {
  rmaId: number;
  reason?: string;
  actorId: string;
}

// `retail.return.receive` — walks an `authorized` RMA → `received` (warehouse
// `inventory:receive-return` logs the goods in). Staff-gated; `actorId` is the resolved
// caller.
export interface IRetailReturnReceivePayload extends ICorrelationPayload {
  rmaId: number;
  actorId: string;
}

// `retail.return.close` — walks an `inspected` RMA → `closed` (staff
// `order:return-authorize` settles the RMA; the refund, if any, is issued by the later
// refund capability). Staff-gated; `actorId` is the resolved caller.
export interface IRetailReturnClosePayload extends ICorrelationPayload {
  rmaId: number;
  actorId: string;
}

// `retail.return.get` — reads one RMA by id (owner-or-staff `order:read` override via
// `isStaff`). `actorId` is the resolved caller (the buyer for the owner path).
export interface IRetailReturnGetPayload extends ICorrelationPayload {
  rmaId: number;
  actorId: string;
  isStaff: boolean;
}

// `retail.return.list` — lists one order's RMAs newest-first (owner-or-staff `order:read`
// override via `isStaff`). The owner-check is on the order's buyer, resolved from the
// RMAs themselves. `actorId` is the resolved caller.
export interface IRetailReturnListPayload extends ICorrelationPayload {
  orderId: number;
  actorId: string;
  isStaff: boolean;
}
