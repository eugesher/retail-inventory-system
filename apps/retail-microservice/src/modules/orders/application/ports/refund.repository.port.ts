import { Refund } from '../../domain';
import { ITransactionScope } from './transaction.port';

export const REFUND_REPOSITORY = Symbol('REFUND_REPOSITORY');

// The repository seam for the `Refund` aggregate. Returns domain types only — no
// TypeORM entity, `Repository`, or `EntityManager` leaks here (ADR-017 forbids
// `typeorm` in `application/ports`). The TypeORM details live entirely in
// `RefundTypeormRepository`.
//
// The contract the refund operations (Issue Refund + the refund reads, later
// capabilities) depend on:
// - `save` upserts the row and re-reads it so the generated BIGINT id comes back
//   concrete (the "re-read the saved graph" idiom the payment/order repos follow). It
//   accepts an optional `scope` so Issue Refund persists the `Refund` and advances the
//   `Payment` (`refunded_amount_minor` + status) in one short follow-up transaction
//   (ADR-017 §6).
// - `findById` is the by-id load path (scope-aware so Issue Refund can re-read inside
//   its transaction).
// - `findByOrderId` lists an order's refunds newest-first by `issued_at` then `id` —
//   the order-scoped refund history read. It is also a candidate source for the
//   cumulative-refunds cross-check (summing the order's issued refunds) if a use case
//   prefers it over reading `payment.refunded_amount_minor`.
// - `findByPaymentId` lists a payment's refunds — the per-payment history that backs
//   the over-refund guard at issue time. Scope-aware so the guard reads the same
//   transaction Issue Refund writes in.
export interface IRefundRepositoryPort {
  save(refund: Refund, scope?: ITransactionScope): Promise<Refund>;
  findById(id: number, scope?: ITransactionScope): Promise<Refund | null>;
  findByOrderId(orderId: number): Promise<Refund[]>;
  findByPaymentId(paymentId: number, scope?: ITransactionScope): Promise<Refund[]>;
}
