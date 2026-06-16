import { Fulfillment } from '../../domain';
import { ITransactionScope } from './transaction.port';

export const FULFILLMENT_REPOSITORY = Symbol('FULFILLMENT_REPOSITORY');

// The repository seam for the `Fulfillment` aggregate. Returns domain types only —
// no TypeORM entity, `Repository`, or `EntityManager` leaks here (ADR-017 forbids
// `typeorm` in `application/ports`). The TypeORM details live entirely in
// `FulfillmentTypeormRepository`.
//
// Every method is **scope-aware** so the later fulfillment operations can join the
// order's transaction (ADR-017 §6 / ADR-031): Ship persists the fulfillment, advances
// the order's fulfillment axis, and captures payment in one unit of work, so the use
// case hands one `scope` to every repository it touches without ever seeing an
// `EntityManager`. Without a `scope` the method opens its own transaction.
//
// The contract the create / ship / deliver / cancel operations depend on:
// - `save` upserts the root together with its lines and re-reads the saved graph so
//   the generated BIGINT id + `fulfillment_line.id`s come back concrete (the "re-read
//   the saved graph" idiom the order/payment repos follow).
// - `findById` is the by-id load path (the ship/deliver/cancel preconditions resolve
//   a fulfillment by id).
// - `findByIdForUpdate` is the by-id load path **under a pessimistic write lock** — a
//   current read (`SELECT … FOR UPDATE`) that serialises concurrent transitions of the
//   same shipment. Ship and Cancel both re-read the contended fulfillment with it
//   INSIDE their transaction, so the second writer blocks until the first commits and
//   then observes the committed status — at which point its status precondition (Ship's
//   `pending` guard / Cancel's no-`shipped` guard) rejects it. This is the
//   single-writer-per-status-transition guard that makes the status precondition
//   sufficient under contention; it MUST be called inside a transaction (the `scope` is
//   required, not optional — a `FOR UPDATE` outside a transaction would lock nothing).
// - `listByOrderId` lists an order's fulfillments newest-first (by `shipped_at` then
//   `id` — the `(order_id, shipped_at)` index supports it). It backs the order's
//   fulfillment roll-up (the cross-fulfillment sum the Create use case checks, and the
//   no-`shipped`-fulfillment Cancel Order precondition).
export interface IFulfillmentRepositoryPort {
  save(fulfillment: Fulfillment, scope?: ITransactionScope): Promise<Fulfillment>;
  findById(id: number, scope?: ITransactionScope): Promise<Fulfillment | null>;
  findByIdForUpdate(id: number, scope: ITransactionScope): Promise<Fulfillment | null>;
  listByOrderId(orderId: number, scope?: ITransactionScope): Promise<Fulfillment[]>;
}
