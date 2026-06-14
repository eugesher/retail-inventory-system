import { StockMovementTypeEnum } from '@retail-inventory-system/contracts';

import { StockMovement } from '../../domain';
import { ITransactionScope } from './transaction.port';

export const STOCK_MOVEMENT_REPOSITORY = Symbol('STOCK_MOVEMENT_REPOSITORY');

// One page of the audit ledger, newest-first.
export interface IStockMovementPage {
  items: StockMovement[];
  total: number;
}

// The audit list query. Pagination is 1-based (`page`); the optional `type` /
// `from` / `to` narrow the scan. `from` / `to` bound `occurred_at` inclusively.
export interface IStockMovementListQuery {
  variantId: number;
  page: number; // 1-based
  size: number;
  type?: StockMovementTypeEnum;
  from?: Date; // occurred_at >= from
  to?: Date; // occurred_at <= to
}

// The ENTIRE repository surface for the stock-movement ledger — `append` + list,
// and NOTHING else. There is deliberately no `save` / `update` / `delete`: the
// ledger is append-only (ADR-030 §2), and that invariant is enforced HERE, in the
// port's type surface, not merely by convention — an UPDATE or DELETE is not
// expressible against this seam. Domain types only — no `typeorm` leak (ADR-017).
export interface IStockMovementRepositoryPort {
  // INSERT a new movement and re-read it so the DB-assigned BIGINT `id` (and the
  // stored `occurred_at`) come back concrete. Scope-aware so a movement is written
  // in the SAME unit of work as the `StockLevel` counter change that caused it
  // (Release / Allocate / Cancel-Allocation today; Receive / Adjust / Transfer in
  // later capabilities): a rolled-back counter change leaves no orphan movement row.
  append(movement: StockMovement, scope?: ITransactionScope): Promise<StockMovement>;
  // Newest-first (`occurred_at DESC, id DESC`) page of one variant's movements,
  // optionally narrowed by type and an inclusive `occurred_at` window. Backs the
  // audit read RPC + HTTP endpoint (a later capability); the method ships now so
  // the seam is complete.
  listByVariant(query: IStockMovementListQuery): Promise<IStockMovementPage>;
}
