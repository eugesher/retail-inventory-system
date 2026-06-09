// The polymorphic discriminator for an `address` row (ADR-028 §5). An address is
// owned either by a `CUSTOMER` (a reusable address-book entry) or by an `ORDER` (a
// snapshot taken at place-time). A wire contract surfacing on `AddressView` and
// mapped to the `address.owner_type` ENUM column.
//
// `ORDER` is the only owner type produced in this chain: an order's billing and
// shipping addresses are **immutable snapshot copies** written at place-time, never
// references into a customer address book. `CUSTOMER` ships in the enum so the
// polymorphic column shape accepts the later address-book capability without a
// schema change — but it has no producer here.
export enum AddressOwnerTypeEnum {
  CUSTOMER = 'customer',
  ORDER = 'order',
}
