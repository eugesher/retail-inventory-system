import { StockMovementTypeEnum } from '@retail-inventory-system/contracts';

import { StockMovement } from '../../domain';
import { ITransactionScope } from '@retail-inventory-system/ddd';

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
  // INSERT and re-read, so the DB-assigned `id` and stored `occurred_at` come back concrete.
  //
  // **`scope` is what keeps the ledger honest.** Every write path passes one, so the movement lands
  // in the SAME unit of work as the counter change that caused it — a rolled-back change can leave
  // no orphan row explaining a change that never happened.
  append(movement: StockMovement, scope?: ITransactionScope): Promise<StockMovement>;

  // Newest-first page of one variant's movements, optionally narrowed by type and an inclusive
  // `occurred_at` window.
  listByVariant(query: IStockMovementListQuery): Promise<IStockMovementPage>;
  // Reference-based existence probe — the FAST PATH of the Commit Sale (ADR-031) and
  // Restock From Return (ADR-032) idempotency, and **not** its guarantee. A `sale` /
  // `return` movement already referencing the document means the work happened, so a
  // sequential re-delivery short-circuits here without opening a transaction.
  //
  // **A probe cannot make either operation idempotent, whatever `scope` it is given.**
  // It is a check-then-act: two concurrent deliveries both read "absent" and both fall
  // through, and passing the write's `scope` does not close that — under REPEATABLE READ
  // both transactions still read a snapshot in which the other's row does not exist. The
  // guarantee is `UC_STOCK_MOVEMENT_DEDUPE`, the ledger UNIQUE that the losing writer's
  // INSERT breaks (migration `1783872387242`); each use case catches that duplicate-key
  // error and returns the same no-op. Do not "strengthen" this probe — strengthen
  // nothing, it is already only an optimisation.
  //
  // Backed by a `SELECT 1 … WHERE reference_type = ? AND reference_id = ? LIMIT 1`
  // against `IDX_STOCK_MOVEMENT_REFERENCE (reference_type, reference_id)`. It is a READ —
  // the append-only invariant (no save/update/delete) is preserved.
  existsByReference(
    referenceType: string,
    referenceId: string,
    scope?: ITransactionScope,
  ): Promise<boolean>;
}
