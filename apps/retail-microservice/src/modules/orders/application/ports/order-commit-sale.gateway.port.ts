import { ICommitSalePayload, ICommitSaleResult } from '@retail-inventory-system/contracts';

export const ORDER_COMMIT_SALE_GATEWAY = Symbol('ORDER_COMMIT_SALE_GATEWAY');

// The orders context's outbound seam onto `inventory.stock.commit-sale` (ADR-031). A **separate,
// module-prefixed port** from `ORDER_INVENTORY_GATEWAY` — one port per inventory concern, so a
// change to the allocate seam cannot silently widen the ship seam.
//
// **Commit Sale runs AFTER the local ship transaction has committed.** That is the whole shape of
// the risk here: the order is already shipped and durable, so a failure on this call cannot unship
// anything. It can only leave inventory's counters behind reality.
//
// **Inventory's idempotency on `fulfillmentId` protects a CONCURRENT redelivery as well as a
// sequential one.** It did not always: the probe there runs outside its write transaction, so two
// deliveries of one `fulfillmentId` in flight at once both read "absent" and both decremented —
// and a retry fired after a **timeout** is exactly that case, because a timeout does not cancel the
// RPC. `UC_STOCK_MOVEMENT_DEDUPE` (migration `1783872387242`) closed it: the probe is the fast path,
// the ledger UNIQUE is the guarantee, and the losing writer's INSERT is caught and returned as the
// same no-op. `test/concurrent-commit-sale.e2e-spec.ts` pins it.
//
// So the earlier prohibition here — *"do not add a concurrent retry on the strength of the word
// idempotent"* — no longer applies, and is recorded only so its removal is not read as an oversight.
// What still argues against a bigger retry budget is latency, not correctness: the caller awaits
// this inside its HTTP request (`COMMIT_SALE_MAX_ATTEMPTS`).
//
// A rejection reaches the caller with its typed `{ statusCode, message, code, details }` intact.
export interface IOrderCommitSaleGatewayPort {
  commitSale(payload: ICommitSalePayload): Promise<ICommitSaleResult>;
}
