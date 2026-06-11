import { ICorrelationPayload } from '../../microservices';

// A single address bundle supplied on the Place Order request body — the buyer's
// billing or shipping address. At place-time each becomes an immutable
// `ownerType=order` `Address` snapshot copied onto the order (ADR-028 §5), never a
// reference into a (future) customer address book. `line2` / `phone` are optional;
// `country` is a 2-letter ISO code (the gateway DTO validates length, the domain
// upper-cases + re-validates). The same shape is the source of truth for the
// gateway request DTO's nested object and the retail use case's snapshot input.
export interface IAddressInput {
  recipientName: string;
  line1: string;
  line2?: string;
  city: string;
  region: string;
  postalCode: string;
  country: string;
  phone?: string;
}

// Wire-format command payload for `retail.cart.place` (API Gateway → Retail).
// Extends `ICorrelationPayload` so the correlation id threads through to the
// retail handler's inline logging (ADR-001 / ADR-011). The single source of truth
// for both ends: the gateway adapter sends it and the retail `PlaceOrderUseCase`
// consumes it.
//
// `customerId` is the resolved caller (the gateway folds `@CurrentUser().id` in);
// the retail use case re-asserts `cart.customerId === customerId` as the
// owner-check (ADR-028 §7). `shippingAddress` / `billingAddress` are the snapshot
// bundles. `paymentMethod` is an optional opaque method token forwarded to the
// `PAYMENT_GATEWAY` (the fake ignores it beyond echoing a default).
// `idempotencyKey` is **accepted and logged but not deduped** in this capability —
// repeat-place safety comes from cart state (a placed cart is `converted`;
// re-placing returns the order it converted into via `source_cart_id`), Q10 /
// ADR-028 §6. A persisted idempotency store is a later capability.
export interface IPlaceOrderPayload extends ICorrelationPayload {
  cartId: string;
  customerId: string;
  shippingAddress: IAddressInput;
  billingAddress: IAddressInput;
  paymentMethod?: string;
  idempotencyKey?: string;
}
