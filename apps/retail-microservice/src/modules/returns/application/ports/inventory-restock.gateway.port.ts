import {
  IRestockFromReturnPayload,
  IRestockFromReturnResult,
} from '@retail-inventory-system/contracts';

export const INVENTORY_RESTOCK_GATEWAY = Symbol('INVENTORY_RESTOCK_GATEWAY');

// The returns context's outbound seam onto the inventory **restock-from-return** surface
// (`inventory.stock.restock-from-return`, ADR-032). A module-prefixed gateway port — the
// `ORDER_INVENTORY_GATEWAY` / `ORDER_COMMIT_SALE_GATEWAY` precedent (ADR-030/031): the
// Inspect & Disposition use case depends only on this port, never on
// `@nestjs/microservices`, which keeps it transport-free and unit-testable; the concrete
// `InventoryRestockRabbitmqAdapter` holds the `ClientProxy` (ADR-009 / ADR-020).
//
// Restock runs **after** the local inspection commit and is **idempotent on
// `returnRequestId`** inventory-side, so the use case may retry a transient failure
// safely (bounded-retry-then-log — the inspection is never rolled back). A rejection
// reaches the caller with its typed `{ statusCode, message, code, details }` intact (the
// adapter wraps it in `RpcException`), so the retry/log posture has the full payload.
export interface IInventoryRestockGatewayPort {
  restockFromReturn(payload: IRestockFromReturnPayload): Promise<IRestockFromReturnResult>;
}
