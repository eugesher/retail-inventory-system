import { ICorrelationPayload } from '../../microservices';

// At place-time each bundle becomes an **immutable `ownerType=order` `Address` snapshot** copied
// onto the order (ADR-028 §5). It is not a reference — there is no customer address book in this
// system, and editing a customer's details later cannot rewrite where a past order shipped.
//
// `country` is a 2-letter ISO code, validated for length at the gateway and upper-cased and
// re-validated in the domain: the wire type says `string` and means less than that.
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

// `retail.cart.place` — the one-shot that turns a mutable cart into an immutable order.
//
// `customerId` is the resolved caller, and retail re-asserts `cart.customerId === customerId`
// itself rather than trusting the gateway's owner-check (ADR-028 §7). `paymentMethod` is an opaque
// token forwarded to the `PAYMENT_GATEWAY`; the bound fake ignores it beyond echoing a default.
//
// **`idempotencyKey` is optional in the type and required in fact** (ADR-036): the use case
// fingerprints the canonical body, replays the stored `OrderView` on a same-key/same-body retry,
// `422`s a same-key/different-body reuse, and `400`s an absent key.
//
// **Cart state is the durable second layer.** Even a re-place under a *brand-new* key, on a cart
// already `converted`, returns the order it converted into — resolved through `source_cart_id`
// (ADR-028 §6). The idempotency store can expire; the cart's status cannot. Double-placing is
// therefore blocked by two independent mechanisms, and the slower one is the one that never
// forgets.
export interface IPlaceOrderPayload extends ICorrelationPayload {
  cartId: string;
  customerId: string;
  shippingAddress: IAddressInput;
  billingAddress: IAddressInput;
  paymentMethod?: string;
  idempotencyKey?: string;
}
