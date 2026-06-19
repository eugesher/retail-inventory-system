import { ReturnRequest } from '../../domain';
import { ITransactionScope } from './transaction.port';

export const RETURN_REQUEST_REPOSITORY = Symbol('RETURN_REQUEST_REPOSITORY');

// The repository seam for the `ReturnRequest` aggregate. Returns domain types only —
// no TypeORM entity, `Repository`, or `EntityManager` leaks here (ADR-017 forbids
// `typeorm` in `application/ports`). The TypeORM details live entirely in
// `ReturnRequestTypeormRepository`.
//
// `save` / `findById` are **scope-aware** so the later returns operations can join a
// transaction (ADR-017 §6 / ADR-032): Inspect/Close persist the RMA alongside the
// orders `Refund` + `Payment` writes in one unit of work, so the use case hands one
// `scope` to every repository it touches without ever seeing an `EntityManager`.
// Without a `scope` the method opens its own transaction. `listByOrderId` is a plain
// read (no scope) — it backs both the list endpoint and the Open use case's
// already-returned-quantity sum.
//
// The contract the open / authorize / reject / receive / inspect / close operations
// depend on:
// - `save` upserts the root together with its lines and re-reads the saved graph so
//   the generated BIGINT id + `return_line.id`s come back concrete and the
//   `rma_number` is finalized to `RMA-<year>-<pad8(id)>` (the "re-read the saved
//   graph, then finalize a derived field" idiom the order repo follows).
// - `findById` is the by-id load path (the lifecycle preconditions resolve an RMA by
//   id).
// - `listByOrderId` lists an order's return requests newest-first (by `requested_at`
//   then `id` — the `(order_id, requested_at)` index supports it).
//
// `nextRmaSequence()` is intentionally absent — the RMA number derives from the
// generated id (the order-number precedent), so there is no sequence table.
export interface IReturnRequestRepositoryPort {
  save(returnRequest: ReturnRequest, scope?: ITransactionScope): Promise<ReturnRequest>;
  findById(id: number, scope?: ITransactionScope): Promise<ReturnRequest | null>;
  listByOrderId(orderId: number): Promise<ReturnRequest[]>;
}
