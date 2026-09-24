import { ReturnRequest } from '../../domain';

export const RETURN_REQUEST_REPOSITORY = Symbol('RETURN_REQUEST_REPOSITORY');

// The NON-transactional read seam for the `ReturnRequest` aggregate (ADR-063) — every
// method here runs off the default connection and never joins a caller's transaction.
// The write-capable half (`save`, and the in-transaction re-read Inspect & Disposition
// needs) lives on `IReturnRequestWriteRepositoryPort`, reachable only through
// `IReturnsUnitOfWork` — there is no `scope` parameter left to forget here or there.
//
// - `findById` backs the owner-checked read (`loadOwnedReturn`) and the staff-gated
//   existence check (`loadReturnById`) — both resolve the RMA before any write use case
//   opens a unit of work.
// - `listByOrderId` lists an order's return requests newest-first (by `requested_at` then
//   `id`); it backs both the list endpoint and Open's already-returned-quantity sum.
export interface IReturnRequestRepositoryPort {
  findById(id: number): Promise<ReturnRequest | null>;
  listByOrderId(orderId: number): Promise<ReturnRequest[]>;
}
