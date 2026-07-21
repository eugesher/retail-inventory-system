---
title: CRM tags
cluster: Customer & Identity
effort: 1 capability
attaches_to:
  - apps/api-gateway/src/modules/auth/domain/customer.model.ts
  - apps/api-gateway/src/modules/customer-admin/
---

# CRM tags

## Description

CRM tags are short labels staff apply to a customer to drive segmentation and workflow — `vip`,
`wholesale-lead`, `chargeback-risk`, `net-30-approved`. They are the lightest customer-annotation
capability there is: a controlled vocabulary of labels, and a many-to-many assignment of those labels to
customers. Shopify's customer tags, HubSpot's contact tags and Zendesk's user tags are all this shape. The
capability is small; the one thing it must get right is that a tag label is **not** a notes field for
personal data.

## Business needs

- **Ad-hoc segmentation** — staff mark a cohort ("interested in the spring line") that is looser than a
  rule-based segment but still needs to be filtered on.
- **Workflow flags** — an operational marker (`chargeback-risk`, `requires-manual-review`) that other
  processes branch on.
- **Sales/CRM continuity** — a tag captures a human judgement ("high-touch account") that no automated
  rule would infer.
- The threshold: a shop with a handful of customers never needs this; the first time staff want to mark
  and later filter customers by a label the system does not otherwise model is where tags attach.

## Attachment points in the current core

- **The `Customer` aggregate at
  `apps/api-gateway/src/modules/auth/domain/customer.model.ts`.** The party a tag is applied to, keyed on
  its `CHAR(36)` UUID. A tag assignment is an id-keyed row and carries no PII of its own — provided the tag
  *label* stays PII-free (see below).
- **The `customer-admin` module at `apps/api-gateway/src/modules/customer-admin/`** — the **staff-facing
  admin shell over `Customer`**. Tag CRUD is a staff operation, so it attaches here, not to a
  customer-facing route; it is gated by a staff permission code the way the other customer-admin operations
  are, and applying a tag is a **staff action** that flows through the `audit.staff.action` audit trail.
- **The audit log's no-PII rule** ([ADR-037](../../adr/037-consent-record-and-tombstone-erasure.md) §4). A
  staff tag action is audited, and audit rows carry ids and state — **never PII**, because the audit log is
  a durable, replicated, hard-to-purge store a "right to be forgotten" must not seed. This is exactly why a
  tag label must be controlled, not free text.

## Implementation sketch

- **A tag vocabulary** — a `CustomerTag` (id + label + optional colour/description), a controlled set staff
  manage — and a **`(customerId, tagId)` assignment** join. Keeping the label in a *vocabulary* row and
  assigning by `tagId` (not by re-typing a string) is what makes the assignment an opaque id reference.
- **The PII constraint is the design, not a footnote.** A tag label must be a **category, not a person's
  details**: `chargeback-risk` is fine, `johns-wife-sarah-0155-1234` is a privacy defect. Because a tag
  assignment is a staff-audited action (and could be emitted as an event), a label carrying personal data
  would **re-seed the audit log and firehose with PII the erase is meant to remove** — defeating
  tombstone erasure. The capability therefore ships a **controlled vocabulary** (staff pick from defined
  tags) rather than a free-text field; a genuine free-text note about a customer belongs in a separate,
  erasable notes capability that is explicitly *not* audited or emitted, never in a tag label.
- **Erasure.** Tag *assignments* are behavioural data about the (now-erased) person, so on tombstone erase
  the customer's `(customerId, tagId)` rows are dropped along with the PII nulling (ADR-037 §2). The tag
  **vocabulary** itself is not customer data and survives — `chargeback-risk` as a definition is not
  personal information.
- **Events** ride `ris.events` if added — `customer.tagged` / `customer.untagged`, carrying `customerId` +
  `tagId` only, **never the label text** as PII. Ids are opaque; the label is resolved from the vocabulary
  by anyone who needs it.
- **Shared types** (the tag and assignment views) under `libs/contracts/customer/`.

## Open design questions

- **Controlled vocabulary vs. free-form tags.** A controlled vocabulary is the PII-safe default, but staff
  often want to coin a tag on the spot. Allowing free-form re-introduces the PII risk unless the input is
  validated against a label pattern (no digits-that-look-like-phone-numbers, length caps) — and even then a
  determined operator can encode PII. The honest answer is controlled-by-default with an audited
  vocabulary-extension path, not open free text.
- **Tag-driven segments.** A tag is a manual grouping; a [customer segment](customer-segments-and-tiers.md)
  is a rule-based one. Should a static segment simply *be* a tag, or are they distinct? Collapsing them
  keeps one grouping model; keeping them separate distinguishes "a human marked this" from "a rule matched
  this".
- **Who may create vs. apply tags** — one permission code for both, or a split (senior staff define the
  vocabulary, all staff apply from it)?

## Effort sketch

`1 capability` — a tag vocabulary, a customer-tag assignment join, and staff CRUD in `customer-admin`. It
is genuinely small; the only non-trivial part is the discipline that keeps PII out of the label, which is a
validation-and-convention concern, not extra machinery.
