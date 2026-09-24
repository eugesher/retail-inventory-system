import { ReturnRequest } from '../../domain';

// The write-capable half of the `ReturnRequest` repository seam (ADR-063) — reachable
// ONLY through `IReturnsUnitOfWork`, never injected on its own. No `scope` parameter on
// either method: both are already bound to the transaction's own `EntityManager` by
// construction, so a transactional write of a return request cannot be attempted outside
// `returnsUnitOfWork.run(...)`.
//
// - `save` upserts the root together with its lines and re-reads the saved graph so the
//   generated BIGINT id + `return_line.id`s come back concrete and the `rma_number` is
//   finalized to `RMA-<year>-<pad8(id)>` (the "re-read the saved graph, then finalize a
//   derived field" idiom, unchanged from the pre-UoW repository). The optional
//   `expectedVersion` makes the root write a version-checked compare-and-swap on
//   `version` (ADR-036); absent on the Open insert (no live row to race).
// - `findById` is the in-transaction re-read: Inspect & Disposition reads the RMA fresh
//   inside its own unit of work (it mutates every line plus the root in one attempt), and
//   a retried attempt must start from an un-inspected re-read rather than the stale
//   in-memory copy a failed attempt mutated.
export interface IReturnRequestWriteRepositoryPort {
  findById(id: number): Promise<ReturnRequest | null>;
  save(returnRequest: ReturnRequest, expectedVersion?: number): Promise<ReturnRequest>;
}
