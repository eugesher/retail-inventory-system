export const RETURN_CUSTOMER_CONTACT_READER = Symbol('RETURN_CUSTOMER_CONTACT_READER');

// A flat read projection of one customer's notification contact — just the `email` the
// return events carry so the notification consumer has a recipient without a per-delivery
// cross-service RPC (ADR-033's "carry the email on the event" choice). `email` is nullable
// because **`customer.email` is nullable**: an erasure nulls the PII in place and leaves the row
// as a tombstone (ADR-037), so a live customer id can genuinely resolve a null email. A customer
// id that resolves no row at all is the whole-result `null` below.
export interface IReturnCustomerContact {
  email: string | null;
}

// The returns context's read seam onto the gateway-owned `customer` table. It is a **local
// copy** of the orders module's port, not a shared import: returns is a sibling bounded
// context behind the boundaries-lint isolation line (ADR-017), so it owns its own port +
// adapter rather than reaching across to the orders module (the `retry-then-log-for-replay`
// per-module-copy precedent, ADR-032). The adapter reads `customer` with PARAMETERIZED SQL
// through the injected `EntityManager`, exactly as `RETURN_ORDER_READER` reaches the order
// tables. The opaque shared FK (`return_request.customer_id` → `customer.id`) is the only
// coupling.
//
// `findContactByCustomerId` resolves the contact (read-only, outside any transaction); a
// customer id that matches no row is `null` (the producing use case maps that to
// `customerEmail: null`). Domain/contract types only — no `typeorm` leak (ADR-017).
export interface IReturnCustomerContactReaderPort {
  findContactByCustomerId(customerId: string): Promise<IReturnCustomerContact | null>;
}
