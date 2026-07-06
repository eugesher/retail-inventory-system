import { Customer } from '../../domain';

export const CUSTOMER_ERASURE_WRITER = Symbol('CUSTOMER_ERASURE_WRITER');

// The cross-context erasure writer seam (ADR-037 §3). A customer's PII spans two
// bounded contexts in the shared `retail_db`: the gateway `auth` module owns
// `customer`, and the retail `orders` module owns `address` / `cart`. This port
// lets `EraseCustomerUseCase` null all of it in **one transaction** without
// importing the retail entities — the adapter reaches the `address` / `cart`
// tables with parameterized SQL through the injected `EntityManager`, the
// cross-context reader-port precedent (`ORDER_CART_READER` / `RETURN_ORDER_READER`)
// applied to a write.
//
// The single transaction gives the erase atomicity (the customer row and the
// downstream PII are nulled together or not at all) and a single auditable erase
// site, which the rejected event-driven alternative could not provide.
export interface ICustomerErasureWriterPort {
  // Persist an already-`erase()`-d `Customer` aggregate (null PII, `status='deleted'`,
  // `deletedAt`, null `refreshTokenHash`) AND, in the same transaction, null the
  // customer's `owner_type='customer'` `address` PII and abandon the customer's
  // active `cart` rows. The `owner_type='order'` address snapshots are immutable
  // and never touched (ADR-028 §5).
  persistErasure(customer: Customer): Promise<void>;
}
