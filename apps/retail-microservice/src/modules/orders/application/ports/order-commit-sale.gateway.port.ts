import { ICommitSalePayload, ICommitSaleResult } from '@retail-inventory-system/contracts';

export const ORDER_COMMIT_SALE_GATEWAY = Symbol('ORDER_COMMIT_SALE_GATEWAY');

// The orders context's outbound seam onto the inventory **commit-sale** surface
// (`inventory.stock.commit-sale`, ADR-031). A **separate, module-prefixed port** from
// `ORDER_INVENTORY_GATEWAY` (the allocate/cancel seam) so each maps to one inventory
// concern — the retired `INVENTORY_CONFIRM_GATEWAY` precedent (ADR-013, gone) and the
// ADR-030/031 per-seam convention. The Ship use case depends only on this port, never
// on `@nestjs/microservices`, which keeps it transport-free and unit-testable; the
// concrete `OrderCommitSaleRabbitmqAdapter` holds the `ClientProxy` (ADR-009 / ADR-020).
//
// Commit Sale runs **after** the local ship commit and is **idempotent on
// `fulfillmentId`** inventory-side, so the use case may retry a transient failure
// safely. A rejection reaches the caller with its typed `{ statusCode, message, code,
// details }` intact (the adapter wraps it in `RpcException`).
export interface IOrderCommitSaleGatewayPort {
  commitSale(payload: ICommitSalePayload): Promise<ICommitSaleResult>;
}
