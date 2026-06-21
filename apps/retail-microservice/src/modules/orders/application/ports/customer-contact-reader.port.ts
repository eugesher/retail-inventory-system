export const ORDER_CUSTOMER_CONTACT_READER = Symbol('ORDER_CUSTOMER_CONTACT_READER');

// A flat read projection of one customer's notification contact — just the `email` the
// order events carry so the notification consumer has a recipient without a per-delivery
// cross-service RPC (ADR-033's "carry the email on the event" choice). `email` is nullable
// to model a future tombstoned customer (PII nulled in place) even though the column is
// NOT NULL today; a customer id that resolves no row is the whole-result `null` below.
export interface IOrderCustomerContact {
  email: string | null;
}

// The orders context's read seam onto the gateway-owned `customer` table. The `customer`
// aggregate lives in the API gateway behind a hard isolation line — the boundaries lint
// forbids the orders module from importing the gateway's `CustomerEntity` (ADR-017). So its
// adapter reads `customer` with PARAMETERIZED SQL through the injected `EntityManager`,
// exactly as `ORDER_CART_READER` reaches the cart tables and pricing reaches the
// catalog-owned `product_variant.tax_category_id` (ADR-017 / ADR-026 §5). The opaque shared
// FK (`order.customer_id` → `customer.id`) is the only coupling; the `?` placeholder is bound
// by the driver, never string-concatenated.
//
// `findContactByCustomerId` resolves the contact (read-only, outside any transaction); a
// customer id that matches no row is `null` (the producing use case maps that to
// `customerEmail: null`). Domain/contract types only — no `typeorm` leak (ADR-017).
export interface IOrderCustomerContactReaderPort {
  findContactByCustomerId(customerId: string): Promise<IOrderCustomerContact | null>;
}
