import { Payment } from '../../domain';
import { ITransactionScope } from '@retail-inventory-system/ddd';

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
// - `findByOrderId` resolves the single payment for an order — **an order has exactly one
//   payment**, because nothing anywhere creates a second one; that is why the shape is a
//   single `Payment | null` and not an array. It accepts an optional
//   `scope` so a use case that retries its transaction on an optimistic conflict
//   (capture / ship / cancel, ADR-036) re-loads the payment INSIDE each attempt's
//   transaction — a fresh domain object per attempt keeps its mutators
//   (`beginCapture` / `void` / `flagForRefund`) valid on a retry.
// - `findByOrderIdForUpdate` is a `SELECT … FOR UPDATE` — **a CURRENT read, not a snapshot
//   one** — and it is the mutual exclusion that makes a double charge impossible (ADR-052).
//   Every path that is about to call `paymentGateway.capture()` must take it, assert
//   `AUTHORIZED`, write the `CAPTURING` claim and **commit**, all before the gateway is
//   touched. The loser of a race blocks on this row, wakes to find `CAPTURING`, and is
//   rejected while the customer's money is still their own. `scope` is REQUIRED: a row lock
//   outside a transaction is released immediately and guards nothing.
// - `listStaleCaptureClaims` finds `CAPTURING` rows last touched before `olderThan` — the payments a
//   crash stranded between the claim and the completion. **It is a READ.** Nothing on this port
//   resolves such a row, and that is deliberate (ADR-052): the gateway offers no "did my charge
//   land?" query, so releasing the claim risks a second charge and completing it risks recording
//   money that never moved. **There is no safe automatic answer, so the system does not invent one**
//   — it surfaces the row for a human.
export interface IPaymentRepositoryPort {
  save(payment: Payment, scope?: ITransactionScope): Promise<Payment>;
  findById(id: number): Promise<Payment | null>;
  findByOrderId(orderId: number, scope?: ITransactionScope): Promise<Payment | null>;
  findByOrderIdForUpdate(orderId: number, scope: ITransactionScope): Promise<Payment | null>;
  listStaleCaptureClaims(olderThan: Date): Promise<Payment[]>;
}
