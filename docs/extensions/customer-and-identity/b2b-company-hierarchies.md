---
title: B2B company hierarchies
cluster: Customer & Identity
effort: subsystem-scale (5+ capabilities)
attaches_to:
  - apps/api-gateway/src/modules/auth/domain/customer.model.ts
  - apps/catalog-microservice/src/modules/catalog/domain/category.model.ts
---

# B2B company hierarchies

## Description

A large business buyer is not one account but a tree: a parent company with regional subsidiaries, each
with departments or cost-centres, each with its own authorised buyers. A purchase made by a buyer in
"Acme EMEA / Facilities" rolls up to Acme EMEA for a credit limit and to Acme for consolidated invoicing.
Shopify B2B's company locations, Adobe Commerce B2B's company hierarchy and commercetools' business units
all model this as a tree of accounts sitting above the individual buyer.

This guide builds on the **`BusinessAccount` party** that [B2B quotes, purchase orders and credit
terms](../order-management/b2b-quote-po-credit-terms.md) owns — the organisation carrying authorised buyers, a credit limit
and payment terms. It **inherits that party rather than re-modelling it**, and adds one thing: a
**hierarchy** of accounts, with the roll-up semantics a tree implies.

## Business needs

- **Enterprise buyers are organisations, not people** — one contract, many buying locations, and spend
  that has to aggregate up a reporting line.
- **Delegated purchasing authority** — a departmental buyer can place orders up to a limit; larger orders
  route to a parent-level approver.
- **Consolidated invoicing and credit** — a shared credit limit at the parent, or per-subsidiary
  sub-limits, and one invoice stream per billing entity rather than per buyer.
- **Scoped contract pricing** — a negotiated price applies to a whole company or one subsidiary, which
  needs the tree to scope against.
- The threshold: a single wholesale account never needs this; the first buyer who says "bill my head
  office but ship to twelve branches, each with its own budget" is where a flat account stops being
  enough.

## Attachment points in the current core

- **The `Customer` aggregate at
  `apps/api-gateway/src/modules/auth/domain/customer.model.ts`.** An individual buyer is still a
  `Customer` — the person who authenticates and places the order. The hierarchy sits **above** the
  customer: a buyer links to a leaf account in the tree, and the tree carries the org structure, not the
  person's PII.
- **The `Category` aggregate at
  `apps/catalog-microservice/src/modules/catalog/domain/category.model.ts`** — the **shape precedent**,
  not an import. `Category` models a hierarchy with a **materialized path** (ADR-029): each node stores its
  full root-to-self path (`/acme/emea/facilities`), so a subtree read is a single
  `path LIKE '/acme/emea%'` rather than a recursive walk, with a self-FK `parentId`, a `reparentUnder`
  mutator, and an `isAncestorOfOrSelf` cycle test that rejects reparenting a node under its own descendant.
  The account tree reuses this exact shape — a proven, cycle-safe hierarchy already in the codebase — so
  the hierarchy is a solved modelling problem, not a new one.

## Implementation sketch

- **Aggregate: `BusinessAccountNode`** — a node in the account tree, carrying a **materialized `path`**, a
  self-referential `parentId`, and a link to the `BusinessAccount` party it belongs to. Cycle rejection and
  subtree reads follow the `Category` precedent verbatim (path-prefix ancestry, no recursive walk).
- **Buyer linkage.** A `Customer` links to a leaf node — the seam that ties an authenticating person to
  their place in the org. A node's authorised buyers are the customers linked at or below it.
- **Roll-up semantics** are the substance of the guide: a **credit limit** is either a shared pool held at
  an ancestor or per-node sub-limits that sum against the parent; **invoicing** consolidates at a billing
  node; **buying authority** is a per-node ceiling with escalation to an approver higher up (which composes
  with a staff-side approval-workflow capability). Each roll-up is a read that walks *up* the path — cheap,
  because the path is materialized.
- **Reparenting** an account (a subsidiary moves under a new parent) rebases the subtree's paths in one
  repository transaction — the `Category.reparentUnder` + `reparentSubtree` precedent, applied to accounts.
- **Events** ride `ris.events` — extend the B2B account surface with `retail.b2b-account.node-added` /
  `.reparented`, carrying account and node ids only. **No PII** (ADR-037): the org tree is ids and paths,
  never a buyer's contact details.
- **Shared types** (the node and tree views) under `libs/contracts/customer/`.

## Open design questions

- **Where the credit limit lives** — one pool at the root, sub-limits per node, or both with the node
  limit bounded by the ancestor's. This is the same enforcement-point question the B2B credit-terms owner
  left open, now multiplied by the tree.
- **Which node an order bills and which ships** — an order placed by a leaf buyer may bill a parent and
  ship to the leaf, so the order needs a billing-node and a ship-node reference, distinct from the buyer.
- **Buyer authority model** — does authority attach to the customer, to the node, or to a role the customer
  holds at a node? A role-at-node model is richer but starts to look like the staff RBAC chain applied to
  buyers.
- **Erasure of a buyer inside a tree.** A `Customer` still tombstone-erases (PII nulled, id preserved), and
  the account node is org data that survives — but the buyer's *contact* on the node is PII and must null.
  Confirm the node stores no un-nulled buyer PII of its own.

## Effort sketch

`subsystem-scale (5+ capabilities)` — the account-tree aggregate, buyer-to-node linkage, credit/invoicing
roll-up, reparenting with subtree rebase, and the order billing/ship-node references. It is a subsystem
because it builds an org structure with roll-up semantics on top of the party the B2B credit-terms guide
defines — and two of those roll-ups (credit, contract-price scope) are themselves capabilities.
