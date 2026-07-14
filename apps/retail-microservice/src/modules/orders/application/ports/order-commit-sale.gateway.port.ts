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
// **Inventory's idempotency on `fulfillmentId` protects a SEQUENTIAL retry, not a concurrent one.**
// The probe there runs outside its transaction and there is no UNIQUE backing it, so two
// deliveries of the same `fulfillmentId` in flight at once can both decrement. Retrying after a
// timeout is safe; retrying *while the first attempt may still be running* is not. **Do not add a
// concurrent retry here on the strength of the word "idempotent".**
//
// A rejection reaches the caller with its typed `{ statusCode, message, code, details }` intact.
export interface IOrderCommitSaleGatewayPort {
  commitSale(payload: ICommitSalePayload): Promise<ICommitSaleResult>;
}
