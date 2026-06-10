import { Payment } from '../../domain';

export const PAYMENT_REPOSITORY = Symbol('PAYMENT_REPOSITORY');

// The repository seam for the `Payment` aggregate. Returns domain types only — no
// TypeORM entity, `Repository`, or `EntityManager` leaks here (ADR-017 forbids
// `typeorm` in `application/ports`). The TypeORM details live entirely in
// `PaymentTypeormRepository`.
//
// The payment operations land in later capabilities (authorize-on-place,
// capture-explicit); this foundation only fixes the contract:
// - `save` upserts the row and re-reads it so the generated BIGINT id comes back
//   concrete (the "re-read the saved graph" idiom the order/address repos follow).
// - `findById` is the by-id load path.
// - `findByOrderId` resolves the single payment for an order — one payment per order
//   in this capability (split-payment / multi-capture are later capabilities), so a
//   single `Payment | null` is the right shape, not an array.
export interface IPaymentRepositoryPort {
  save(payment: Payment): Promise<Payment>;
  findById(id: number): Promise<Payment | null>;
  findByOrderId(orderId: number): Promise<Payment | null>;
}
