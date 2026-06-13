import { ICorrelationPayload } from '../../microservices';

// RPC payload for `inventory.stock-level.transfer` (API Gateway → Inventory). A
// Transfer Stock operation moves a positive `quantity` of on-hand for one variant
// from one stock location to another, atomically (ADR-030): the source loses the
// units, the destination gains them, and the two legs are recorded as a paired
// `adjustment` movement (the ledger has no `transfer` type — a transfer is two
// adjustments sharing a `transfer` reference id).
//
// Unlike Receive/Adjust, BOTH `fromLocationId` and `toLocationId` are required —
// a transfer is intrinsically between two named locations, so there is no default.
// `quantity` is a positive integer; transferring more than the source's on-hand is
// rejected by the same below-zero guard Adjust uses (`STOCK_RESULT_NEGATIVE`, 409).
// `actorId` is the staff user performing the transfer (threaded from the gateway's
// `@CurrentUser()`); it is attributed to both ledger rows (null = system). It
// extends `ICorrelationPayload` (the correlation id is always threaded by the
// gateway on this command path); this interface doubles as the
// `TransferStockUseCase` input shape.
export interface IStockTransferPayload extends ICorrelationPayload {
  variantId: number;
  fromLocationId: string;
  toLocationId: string;
  quantity: number;
  actorId?: string;
}
