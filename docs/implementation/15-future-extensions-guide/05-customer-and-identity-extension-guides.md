# 05 — Customer & Identity extension guides

The seven Customer & Identity guides under [`docs/extensions/`](../../extensions/) sketch how a business
would grow the identity model past the universal core. Every capability in this cluster touches **personal
data**, so the governing discipline is not "add a customer attribute" but "add a customer attribute and say
what an erase does to it". A sketch that proposes a new field and stays silent on erasure is incomplete by
construction here — the erasure table below is the section a reviewer checks first.

`Customer` is the one aggregate that is **gateway-owned domain state**
([`apps/api-gateway/src/modules/auth/domain/customer.model.ts`](../../../apps/api-gateway/src/modules/auth/domain/customer.model.ts)),
not a microservice's. Every path, field, port symbol and routing key named below was read out of the source
directly, because the point-in-time notes in this folder describe a capability at ship time, not
necessarily its shape today.

## The privacy rails, verified against the code

Three rails bind every guide, and each was confirmed against source rather than assumed:

1. **Erasure is tombstone-only.** `Customer.erase()` nulls `email`, `phone`, `firstName`, `lastName`,
   `passwordHash`, `emailVerifiedAt` and `refreshTokenHash`, flips `status → 'deleted'`, and stamps
   `deletedAt` — **preserving the `CHAR(36)` id** so every `order.customer_id` FK stays valid. The columns
   are nullable precisely to make this representable
   ([ADR-037](../../adr/037-consent-record-and-tombstone-erasure.md) §2). Any new attribute a sketch adds
   must declare its erasure fate.
2. **No PII in an event payload or an audit row — with a documented exception.** ADR-037 §4 is strict about
   the *erase* surface: `customer.erased` carries `customerId` / `erasedAt` / `actorStaffUserId` only, and
   the erase audit row is a `{ status }` transition. But the retail order events are pragmatically *not*
   PII-free: `IRetailOrderPlacedEvent` optionally carries `customerEmail` / `customerLocale` for the
   notification fan-out. So the loyalty accrual keys on the event's `customerId` and ignores the email — and
   every **new** event a sketch emits (`retail.loyalty.*`, `customer.segment.*`, `customer.tagged`) carries
   ids only. The rule a sketch must honour is about the events *it* introduces.
3. **Consent is default-transactional-on, default-marketing-off.** `ConsentRecord`
   ([`consent-record.model.ts`](../../../apps/api-gateway/src/modules/auth/domain/consent-record.model.ts))
   defaults `transactionalEmail = true`, `marketingEmail = marketingSms = false`. The notification service
   already reads it through `CONSENT_READER` / `CONSENT_CACHE`, cache-aside under the
   `CACHE_KEYS.notificationsConsent(customerId)` builder — a marketing send over a segment reuses that gate,
   it does not invent one.

## The seven guides

### [customer-segments-and-tiers.md](../../extensions/customer-segments-and-tiers.md)

- **Claim.** A named grouping of customers — static (curated list) or dynamic (rule over attributes and the
  order stream). **Owns the segment/tier concept** for the whole system; a tier is a ranked segment with
  benefits.
- **Attaches to.** `Customer` (the party grouped) and `ConsentRecord` (marketing opt-in — the gate a
  marketing send filters on).
- **Hardest to reverse.** Whether static and dynamic segments are one `kind`-discriminated aggregate or two.
  Everything downstream reads "membership", so a later reshape touches every consumer.

### [loyalty-programs.md](../../extensions/loyalty-programs.md)

- **Claim.** An append-only points **ledger** with a **derived balance** (the `stock_movement` /
  store-credit precedent), accrued off the order-placed event. Tiers are segments (linked, not re-modelled);
  redemption is tender-or-discount.
- **Attaches to.** `Customer` and
  [`order-placed.event.ts`](../../../libs/contracts/retail/events/order-placed.event.ts) (accrual consumes
  it, keying on `customerId`).
- **Hardest to reverse.** Redemption as a `Payment` tender vs. an order discount — it decides whether
  loyalty plugs into `Payment` or into the discount total.

### [b2b-company-hierarchies.md](../../extensions/b2b-company-hierarchies.md)

- **Claim.** A tree of accounts above the B2B party, with credit/invoicing/pricing roll-up. **Inherits the
  `BusinessAccount` party** from [b2b-quote-po-credit-terms.md](../../extensions/b2b-quote-po-credit-terms.md)
  — does not re-model it.
- **Attaches to.** `Customer` (the individual buyer at a leaf) and
  [`category.model.ts`](../../../apps/catalog-microservice/src/modules/catalog/domain/category.model.ts) —
  the **materialized-path** shape precedent (ADR-029): a proven, cycle-safe hierarchy already in the code.
- **Hardest to reverse.** Where the credit limit lives — one pool at the root, per-node sub-limits, or both.

### [wishlists.md](../../extensions/wishlists.md)

- **Claim.** A durable saved-items list — "a cart that never checks out", with the analogy's breaks named.
- **Attaches to.**
  [`cart.model.ts`](../../../apps/retail-microservice/src/modules/cart/domain/cart.model.ts).
- **Hardest to reverse.** Retail-side (beside `Cart`) vs. customer-side (beside the party) ownership — a
  bounded-context call. The analogy breaks at four points: price snapshot (a wishlist is live-priced), the
  OCC-and-CAS checkout machinery (a wishlist never converts), the TTL (a wishlist is durable), and the fixed
  currency (a wishlist is currency-agnostic).

### [social-login-providers.md](../../extensions/social-login-providers.md)

- **Claim.** OAuth/OIDC login that **replaces the password seam** (`PASSWORD_HASHER`) and **reuses
  `TOKEN_SERVICE`** unchanged. Adds a `FederatedIdentity` link and a `LoginWithProvider` use case.
- **Attaches to.** [`libs/auth/`](../../../libs/auth/) (the guard chain, unchanged) and the auth
  [`application/ports/`](../../../apps/api-gateway/src/modules/auth/application/ports/) (the two auth seams).
  The JWT chain is [ADR-010](../../adr/010-jwt-rbac-at-the-gateway.md), linked, not restated.
- **Hardest to reverse.** The `Customer` invariant: `passwordHash` may be null only for `guest` / `deleted`,
  so a social-only **active** customer needs the invariant relaxed (authenticatable via a federated identity)
  or a forced password. This is a real code constraint, not a hypothetical.

### [mfa-and-household-grouping.md](../../extensions/mfa-and-household-grouping.md)

- **Claim.** Customer-facing **opt-in** MFA wrapping the login use case, plus household grouping. **Owns the
  customer-facing MFA story** and draws the customer/staff line (below).
- **Attaches to.** The login
  [`application/use-cases/`](../../../apps/api-gateway/src/modules/auth/application/use-cases/) (MFA inserts a
  challenge between `validatePassword` and token issuance) and `Customer` (its erase already clears
  `refreshTokenHash`; the MFA secret joins that set). JWT chain is [ADR-010](../../adr/010-jwt-rbac-at-the-gateway.md).
- **Hardest to reverse.** MFA method priority (TOTP vs. SMS vs. both) — a telephony dependency and SIM-swap
  risk ride on the choice.

### [crm-tags.md](../../extensions/crm-tags.md)

- **Claim.** Staff-applied controlled-vocabulary labels on a customer. The label **must stay PII-free**
  because a tag is a staff-audited (and possibly emitted) action — a personal-data label would re-seed the
  durable audit log and firehose with what the erase removes.
- **Attaches to.** `Customer` and the
  [`customer-admin`](../../../apps/api-gateway/src/modules/customer-admin/) admin shell (staff-facing CRUD),
  under the no-PII audit rule of [ADR-037](../../adr/037-consent-record-and-tombstone-erasure.md) §4.
- **Hardest to reverse.** Controlled vocabulary vs. free-form tags — free-form re-introduces the PII risk;
  the PII-safe default is controlled-by-default with an audited vocabulary-extension path.

## What erasure does to each proposed attribute

The single table a reader of this cluster checks first. Every new attribute the seven sketches introduce,
and its fate under `Customer.erase()`:

| Guide | New attribute / row | On erase |
| --- | --- | --- |
| customer-segments-and-tiers | dynamic-segment membership (rule-evaluated) | dropped by construction — a `status='deleted'` customer fails every live-status rule |
| customer-segments-and-tiers | static-segment `(segmentId, customerId)` row | id-only, no PII; retention call whether to purge the inert id or leave it |
| loyalty-programs | `LoyaltyAccount` + points ledger (id-keyed, signed entries) | id-keyed and PII-free, so *can* survive as a liability — **default to forfeiture** (closing negative entry, tombstone the account) unless accounting requires retention |
| b2b-company-hierarchies | `BusinessAccountNode` tree (paths, ids) | org data, survives; any buyer **contact** stored on a node is PII and nulls with the `Customer` |
| b2b-company-hierarchies | buyer→leaf-node link | id-only, survives; the buyer `Customer` tombstones as usual |
| wishlists | `Wishlist` + lines (`customerId`, `variantId`) | **no PII to null** — dropped/abandoned exactly as `Cart` is on erase (ADR-037 §2) |
| social-login-providers | `FederatedIdentity` (`provider`, `providerSubject`) | PII-adjacent (external identifier for the person) — **nulled/dropped**, severing the IdP link, alongside `refreshTokenHash` |
| mfa-and-household-grouping | `CustomerMfaEnrollment` (TOTP secret, phone, backup codes) | secrets/PII — **nulled** with `refreshTokenHash` (the session-revocation set the erase already clears) |
| mfa-and-household-grouping | `Household` membership `(householdId, customerId)` | id-only, dropped; shared benefits re-derive over remaining members |
| crm-tags | tag *assignment* `(customerId, tagId)` | behavioural data about the erased person — **dropped**; the tag *vocabulary* is not customer data and survives |

## Where the customer / staff MFA line falls

Stated once here so the staff-side enforcement capability (Staff & Access Control) can be read against it:

- **Customer MFA (owned by [mfa-and-household-grouping.md](../../extensions/mfa-and-household-grouping.md)) is
  opt-in self-service.** The customer chooses to enrol, manages their own recovery codes, may
  "remember this device", and may disenrol. There is **no mandate** — declining still permits a password
  login. **Consent to enrol is the entire control model.**
- **Staff MFA (the staff-side guide) is policy-driven compliance.** An organisation or a role *mandates* it;
  an admin can require every staff member in a role to enrol; disenrolment is **not** the staff member's
  choice; a non-compliant account is blocked until it enrols.
- **Same TOTP primitive, opposite direction of control.** A customer *consents to* MFA; a staff member is
  *held to* it. The staff-side guide inherits that one sentence and does not re-argue the mechanism.

## Cross-links and ownership, this cluster

- `loyalty-programs.md` → `customer-segments-and-tiers.md` — a loyalty tier is a segment with benefits; the
  segments guide owns the grouping, loyalty owns the points ledger.
- `b2b-company-hierarchies.md` → `b2b-quote-po-credit-terms.md` — inherits the `BusinessAccount` party.
- `social-login-providers.md` and `mfa-and-household-grouping.md` → [ADR-010](../../adr/010-jwt-rbac-at-the-gateway.md)
  — both touch the login flow and neither restates the JWT chain.

Two guides in this cluster are themselves shared-premise **owners** whose dependents live in later clusters:
`customer-segments-and-tiers.md` (a Pricing group-pricing capability and a Notifications campaign capability
consume the segment) and `mfa-and-household-grouping.md` (the staff-side MFA enforcement capability quotes
the boundary above). Those dependents are named in prose only — a guide links **backward**, never forward,
which is what keeps the structure check green at every stage of filling the folder.
