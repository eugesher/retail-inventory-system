import { Payment } from '../../domain';
import { ITransactionScope } from './transaction.port';

export const PAYMENT_REPOSITORY = Symbol('PAYMENT_REPOSITORY');

// The repository seam for the `Payment` aggregate. Returns domain types only — no
// TypeORM entity, `Repository`, or `EntityManager` leaks here (ADR-017 forbids
// `typeorm` in `application/ports`). The TypeORM details live entirely in
// `PaymentTypeormRepository`.
//
// The contract the payment operations depend on:
// - `save` upserts the row and re-reads it so the generated BIGINT id comes back
//   concrete (the "re-read the saved graph" idiom the order/address repos follow).
//   It accepts an optional `scope` so authorize-on-place persists the `Payment` and
//   advances `order.paymentStatus` in one short follow-up transaction (ADR-017 §6).
// - `findById` is the by-id load path.
// - `findByOrderId` resolves the single payment for an order — one payment per order
//   in this capability (split-payment / multi-capture are later capabilities), so a
//   single `Payment | null` is the right shape, not an array.
export interface IPaymentRepositoryPort {
  save(payment: Payment, scope?: ITransactionScope): Promise<Payment>;
  findById(id: number): Promise<Payment | null>;
  findByOrderId(orderId: number): Promise<Payment | null>;
}
