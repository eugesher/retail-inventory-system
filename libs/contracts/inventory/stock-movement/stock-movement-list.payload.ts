import { ICorrelationPayload } from '../../microservices';
import { StockMovementTypeEnum } from '../enums';

// RPC payload for `inventory.stock-movement.list` (Gateway → Inventory). The
// audit read of the append-only `stock_movement` ledger for ONE variant
// (ADR-030 §2): a paginated, newest-first (`occurred_at DESC, id DESC`) timeline,
// optionally narrowed by movement `type` and an inclusive `occurred_at` window.
//
// Pagination is 1-based: `page` is the page index and `size` the page length (the
// gateway DTO defaults these at the edge — `page`→1, `size`→20 — and caps `size`).
// `from` / `to` are ISO-8601 instants that bound `occurred_at` **inclusively**; the
// use case parses them into `Date`s and treats an unparseable value as absent (the
// gateway DTO is the validation gate — `@IsISO8601()`).
//
// Extends `ICorrelationPayload` (correlationId REQUIRED — the gateway always
// threads it on this command path, the reservation-payload convention). The
// response is an `IPage<StockMovementView>` — the canonical paged envelope already
// exported from `@retail-inventory-system/contracts`, reused rather than
// re-declared (it is named only in app-layer code — the inventory use case and the
// gateway — both of which reach the whole contracts barrel, so no cross-area
// contract import is needed).
export interface IStockMovementListPayload extends ICorrelationPayload {
  variantId: number;
  page: number; // 1-based
  size: number;
  type?: StockMovementTypeEnum;
  from?: string; // ISO-8601, inclusive lower bound on occurredAt
  to?: string; // ISO-8601, inclusive upper bound on occurredAt
}
