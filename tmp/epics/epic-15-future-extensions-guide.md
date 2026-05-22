---
id: epic-15
title: Documentation — Future-extensions guide (one markdown per excluded extension)
source_stages: [documentation]
depends_on: []
microservices: []
task_subfolder: tmp/tasks/epic-15-future-extensions-guide/
docs_subfolder: docs/extensions/
---

# Epic 15 — Documentation — Future-extensions guide (one markdown per excluded extension)

## Goal

Author the `docs/extensions/` folder: one short, focused markdown per excluded extension named in the report's Exclusions Register, framed as a **forward-looking expansion guide** (not a backward-looking "rejected" register). Each file describes (1) what the extension is, (2) what business needs justify it, and (3) a high-level implementation sketch — entities, operations, where it attaches to the existing core. The directory becomes a "if you ever wanted X, here's how it would fit" reference, valuable for portfolio-review reading and for future-self orientation. **No production code is touched by this epic** — purely documentation. The epic has no code dependencies and can be picked up at any point in the program, including in parallel with implementation epics.

## In-Scope Entities and Operations

- No code entities or operations.
- **Authoring scope:** one markdown file per extension named in the report's Exclusions Register, plus a `docs/extensions/README.md` index.
- **Filenames (each one a `docs/extensions/<slug>.md`):**
  - **Product Catalog**: `product-bundles.md`, `dynamic-attribute-schemas.md`, `configurable-products-option-dependencies.md`, `digital-good-entitlements.md`, `subscriptions-and-selling-plans.md`, `product-relations-and-recommendations.md`, `brand-entity.md`, `supplier-and-vendor.md`, `multi-locale-translation-tables.md`.
  - **Inventory**: `lot-batch-serial-tracking.md`, `expiry-fifo-rotation.md`, `bin-aisle-shelf.md`, `demand-forecasting-and-safety-stock.md`, `transfer-order-documents.md`, `consigned-vendor-managed-inventory.md`, `abc-classification.md`, `in-transit-as-separate-location.md`.
  - **Order Management**: `subscriptions-recurring-orders.md`, `gift-cards-and-store-credit.md`, `dropshipping-vendor-routing.md`, `marketplace-seller-payouts.md`, `b2b-quote-po-credit-terms.md`, `fraud-and-risk-scoring.md`, `tax-computation-engine.md`, `shipping-rate-engine.md`, `bnpl-state-machines.md`, `replacement-orders-distinct-entity.md`.
  - **Customer & Identity**: `loyalty-programs.md`, `customer-segments-and-tiers.md`, `b2b-company-hierarchies.md`, `wishlists.md`, `social-login-providers.md`, `mfa-and-household-grouping.md`, `crm-tags.md`.
  - **Returns & Refunds**: `exchanges-as-first-class-entity.md`, `repair-workflows.md`, `advance-replacement.md`, `vendor-rmas.md`, `refund-to-store-credit.md`, `return-fraud-scoring.md`.
  - **Pricing & Promotions**: `discounts-and-promotions.md`, `coupons-and-discount-codes.md`, `customer-group-and-tiered-pricing.md`, `b2b-contract-pricing.md`, `dynamic-ai-pricing.md`, `tax-rate-tables.md`, `currency-conversion.md`, `msrp-vs-sale-price.md`.
  - **Notifications & Events**: `marketing-campaigns-and-segmentation.md`, `ab-template-testing.md`, `abandoned-cart-automation.md`, `in-app-inbox-feed.md`, `live-customer-messaging.md`, `push-device-token-registration.md`, `webhook-subscription-management-ui.md`, `scheduled-batch-newsletters.md`.
  - **Staff & Access Control**: `sso-saml-oidc-federation.md`, `mfa-enforcement.md`, `scoped-tenant-aware-roles.md`, `dynamic-abac-policies.md`, `approval-workflows.md`, `session-device-management.md`, `staff-scheduling-and-shifts.md`.
  - **Physical retail (omitted per user scope)**: `physical-retail-pos-terminals.md` — a single combined file describing the entire physical-retail extension surface (POS terminal, Drawer/Till, Cash Pickup, Cashier Session, ShelfTag, PlanogramSlot, in-store hardware peripherals).

**Total files: ~63** plus one `docs/extensions/README.md` index that lists them by cluster.

## Non-Goals

- **Implementing any of these extensions.** They are deferred by design.
- **Full implementation plans / time estimates / tooling specs.** Each file is a sketch, not a project plan.
- **Updating ADRs to "accept" or "reject" each extension.** Extensions are not architectural decisions — they are scope decisions.
- **Cross-linking to specific implementation tasks.** The files refer to existing code by current-state location (e.g. "Order aggregate in `apps/retail-microservice/src/modules/orders/`"), not to historical or scratch artifacts.

## Architectural Decisions Honored

- **Cross-Cutting "Soft delete vs hard delete":** N/A — no code.
- **Cross-Cutting "Event emission":** every extension sketch that adds events must reference the existing `ris.events` topic exchange and dotted routing key convention (ADR-008/020) — i.e., suggest "this extension would emit `<service>.<aggregate>.<action>` on the existing bus", not propose a new transport.
- **ADR-005** (split shared libs): every extension sketch that adds shared types must propose them under `libs/contracts/<cluster>/...`, not as ad-hoc duplicated types.
- **ADR-016 + ADR-022** (cache keys): cache-using sketches reference the `CACHE_KEYS` + version-segment convention.
- **ADR-018** (NestJS monorepo apps + libs): new-microservice sketches reference the `apps/<name>/` convention and the per-module hexagonal layout (ADR-004).

## Persistence Changes

- None.

## Eventing / Messaging

- None.

## API Surface

- None.

## Test Strategy

- **No tests** in this epic. Lint-checked: every file should compile under whatever doc linter the repo uses (typo / dead-link checks if any are configured in CI; today no doc linter is wired, so a manual review pass is the gate).
- **Optional CI check** (out of scope to wire, mentioned as a future-improvement note in the index): a small script that asserts each filename matches an extension named in the report digest (since the report itself lives at `docs/research-summary.md` after a future canonicalization — currently in `tmp/`, which the docs cannot reference).

## Documentation Deliverables

**Per-task markdown files** under `docs/implementation/epic-15-future-extensions-guide/`:

- `01-extension-guide-structure-and-template.md` — the per-file template (Description → Business needs → Implementation sketch → Attachment points → Effort sketch); the front-matter convention; the index README structure.
- `02-product-catalog-extension-guides.md` — covers the nine catalog files (one short summary per).
- `03-inventory-extension-guides.md` — eight files.
- `04-order-management-extension-guides.md` — ten files.
- `05-customer-and-identity-extension-guides.md` — seven files.
- `06-returns-and-refunds-extension-guides.md` — six files.
- `07-pricing-and-promotions-extension-guides.md` — eight files.
- `08-notifications-and-events-extension-guides.md` — eight files.
- `09-staff-and-access-control-extension-guides.md` — seven files.
- `10-physical-retail-extension-guide.md` — one combined file.
- `11-extensions-index-readme.md` — what's in `docs/extensions/README.md`.

**Each `docs/extensions/<slug>.md` file** follows this short template (kept in `01-extension-guide-structure-and-template.md` as the canonical form):

```markdown
# <Human-readable extension name>

## Description
1-2 paragraphs. What the extension is. Concrete examples from real products (Saleor, Vendure, Shopify, Adobe Commerce) when helpful.

## Business needs
Bullet list. What kinds of businesses or verticals require this extension. When the universal core stops being enough.

## Attachment points in the current core
Bullet list. Which existing aggregates, ports, modules, and events this extension would extend or wrap. References use current-state paths (e.g., "the Order aggregate at `apps/retail-microservice/src/modules/orders/domain/`").

## Implementation sketch
Bullet list (or short prose). Entities to add, operations to add, events to emit. Reference the architectural rails (per-module hexagonal layout, ports + adapters, dotted routing keys, append-only or live-ephemeral classification, cache key convention).

## Open design questions
Bullet list. The genuinely-unresolved bits that whoever picks this up would need to decide.

## Effort sketch
One short line. Rough magnitude: "1 epic" / "2-3 epics" / "subsystem-scale (5+ epics)".
```

**`README.md` updates required:**

- Under a new top-level **Extensions and future expansion** section: a short paragraph pointing readers at `docs/extensions/` and explaining what the folder contains (forward-looking expansion guides, NOT a "rejected features" register). Cross-link to `docs/extensions/README.md`.

**`CLAUDE.md` updates required:**

- New top-level **Extension guides** bullet under the existing **Architecture rules location** section, noting that `docs/extensions/` houses sketches for deferred extensions. Reminder: when a future epic implements one of these, the corresponding `docs/extensions/<slug>.md` should be DELETED (or moved into the implementation doc set) so it doesn't drift out of sync with the actual code.

**Exclusions Register documents owned by this epic:** all of them. Every file in the bullet list above.

## Tasks (decomposition hint)

1. **Author the per-file template** + the `docs/extensions/README.md` index skeleton.
2. **Author the nine Product Catalog files.** (~1-2 paragraphs each.)
3. **Author the eight Inventory files.**
4. **Author the ten Order Management files.**
5. **Author the seven Customer & Identity files.**
6. **Author the six Returns & Refunds files.**
7. **Author the eight Pricing & Promotions files.**
8. **Author the eight Notifications & Events files.**
9. **Author the seven Staff & Access Control files.**
10. **Author the one combined Physical Retail file.**
11. **Fill in the index `docs/extensions/README.md`** with the final cluster-grouped table-of-contents.
12. **Update `README.md` + `CLAUDE.md`** with cross-links.
13. **Write the eleven per-task implementation docs** under `docs/implementation/epic-15-future-extensions-guide/`.

## Carryover Between Tasks

| Task | Entry state assumed | Carryover artifacts produced (never under `tmp/`) |
|---|---|---|
| 1 | Pristine `docs/`. | New `docs/extensions/` folder + `README.md` skeleton; one canonical template file (or kept inline in the README). |
| 2 | Task 1 complete. | Nine markdown files under `docs/extensions/`. |
| 3 | Task 1 complete. | Eight markdown files. |
| 4 | Task 1 complete. | Ten markdown files. |
| 5 | Task 1 complete. | Seven markdown files. |
| 6 | Task 1 complete. | Six markdown files. |
| 7 | Task 1 complete. | Eight markdown files. |
| 8 | Task 1 complete. | Eight markdown files. |
| 9 | Task 1 complete. | Seven markdown files. |
| 10 | Task 1 complete. | One combined markdown file. |
| 11 | Tasks 2–10 complete. | Finalized `docs/extensions/README.md` with grouped TOC. |
| 12 | Task 11 complete. | Updated root `README.md` + `CLAUDE.md` cross-links. |
| 13 | All prior tasks complete. | Eleven implementation docs under `docs/implementation/epic-15-future-extensions-guide/`. |

## Exit Criteria

- [ ] ~63 markdown files exist under `docs/extensions/`, one per excluded extension named in the report (and one combined physical-retail file).
- [ ] `docs/extensions/README.md` lists every file, grouped by cluster, with a one-line hook per file.
- [ ] Every `docs/extensions/<slug>.md` file follows the template (Description / Business needs / Attachment points / Implementation sketch / Open design questions / Effort sketch).
- [ ] No file under `docs/extensions/` references anything under `tmp/` — extension guides describe forward-looking work in terms of the existing code state.
- [ ] Root `README.md` has the **Extensions and future expansion** section linking to `docs/extensions/README.md`.
- [ ] `CLAUDE.md` notes the extension-guides convention.
- [ ] Per-task implementation docs present under `docs/implementation/epic-15-future-extensions-guide/`.
- [ ] No production code touched.

## Self-Containment Notice

> Tasks generated from this epic must produce outputs that contain no references to anything under `tmp/`. The orchestration scratch space is not part of the final deliverable. Extension guides describe future work in terms of current code paths and ADRs, never in terms of `tmp/` scratch artifacts.
