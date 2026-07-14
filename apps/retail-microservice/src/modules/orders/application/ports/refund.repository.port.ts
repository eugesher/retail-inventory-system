import { Refund } from '../../domain';
import { ITransactionScope } from '@retail-inventory-system/ddd';

export const REFUND_REPOSITORY = Symbol('REFUND_REPOSITORY');

// The repository seam for the `Refund` aggregate. Returns domain types only — no
// TypeORM entity, `Repository`, or `EntityManager` leaks here (ADR-017 forbids
// `typeorm` in `application/ports`). The TypeORM details live entirely in
// `RefundTypeormRepository`.
//
// The contract the refund operations depend on:
// - `save` upserts the row and re-reads it so the generated BIGINT id comes back
//   concrete (the "re-read the saved graph" idiom the payment/order repos follow). It
//   accepts an optional `scope` so Issue Refund persists the `Refund` and advances the
//   `Payment` (`refunded_amount_minor` + status) in one short follow-up transaction
//   (ADR-017 §6).
// - `findByOrderId` lists an order's refunds newest-first by `issued_at` then `id` —
//   the order-scoped refund history read. It is also a candidate source for the
//   cumulative-refunds cross-check (summing the order's issued refunds) if a use case
//   prefers it over reading `payment.refunded_amount_minor`.
// - `findByPaymentId` lists a payment's refunds — the per-payment history that backs
//   the over-refund guard at issue time. Scope-aware so the guard reads the same
//   transaction Issue Refund writes in.
//
// There is no `findById` (ADR-049). It was declared and implemented and no use case
// called it: Issue Refund reads the payment's history through `findByPaymentId` for its
// over-refund guard, and the refund reads are order- or payment-scoped. A refund is never
// addressed on its own.
export interface IRefundRepositoryPort {
  save(refund: Refund, scope?: ITransactionScope): Promise<Refund>;
  findByOrderId(orderId: number): Promise<Refund[]>;
  findByPaymentId(paymentId: number, scope?: ITransactionScope): Promise<Refund[]>;
}
