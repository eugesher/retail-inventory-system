---
epic: epic-00
task_number: 3
title: Add the `**Date**` header line to ADR-001 to satisfy ADR-003's format rule
depends_on: []
doc_deliverable: null
---

# Task 03 — Add the `**Date**` header line to ADR-001

## Required reading

- **Mandatory:** Read `tmp/adr-summary.md` before starting — the index of architectural decisions of record.
- **Recommended:** For any decision relevant to this task, open the linked original ADR under `docs/adr/` before implementing. In particular, read ADR-001 and ADR-003 in full before committing.

## ADR audited

[ADR-001 — Structured Logging with Pino and Correlation IDs](../../../docs/adr/001-structured-logging-with-pino.md). Accepted. Violates [ADR-003 — Record Architecture Decisions](../../../docs/adr/003-record-architecture-decisions.md) §Format.

## Discrepancy

ADR-003 §Decision (lines 41-44) mandates:

> A `**Date**` and a `**Status**` line at the top (Status is one of: Proposed, Accepted, Superseded by ADR-NNN, Deprecated, Rejected).

ADR-001's current header lacks the `**Date**` line:

```text
docs/adr/001-structured-logging-with-pino.md:1:# ADR-001: Structured Logging with Pino and Correlation IDs
docs/adr/001-structured-logging-with-pino.md:2:
docs/adr/001-structured-logging-with-pino.md:3:**Status:** Accepted
docs/adr/001-structured-logging-with-pino.md:4:
docs/adr/001-structured-logging-with-pino.md:5:---
```

Every other ADR (002 through 023) has both lines:

```text
docs/adr/002-redis-cache-aside-product-stock.md:3:- **Date**: 2026-05-08
docs/adr/002-redis-cache-aside-product-stock.md:4:- **Status**: Accepted
```

ADR-001 predates ADR-003 (both are dated 2026-05-08, but ADR-003 explicitly cites ADR-001 as the format *prototype*), so this is a "first foundational ADR never retro-fit to the rule it inspired" finding.

Surface: `docs/adr/001-structured-logging-with-pino.md` (the ADR prose itself).

## Why this matters

Low severity. A missing Date does not mislead any implementer about the *decision* — it only weakens the audit trail (when was this decision taken? — answer: `git log --diff-filter=A -- docs/adr/001-structured-logging-with-pino.md`). The cost of leaving it stale is small. The cost of fixing it is also small. The interesting question is whether the edit is permissible under ADR-003 line 62 ("Never edit a prior ADR in place beyond flipping its `Status` and adding a one-line supersession pointer").

A strict reading of that rule **forbids** the edit — `**Date**` is neither Status nor a supersession pointer. A pragmatic reading recognises that ADR-003 itself mandates the field, so ADR-001 was always out of compliance and adding it is a *retroactive* compliance fix, not a content change.

The implementer must pick a reading and own the choice.

## Evidence

ADR-003 binding rule on header format (the rule ADR-001 violates):

```text
docs/adr/003-record-architecture-decisions.md:41:- Title: `# ADR-NNN: <decision in active voice>`.
docs/adr/003-record-architecture-decisions.md:42:- A `**Date**` and a `**Status**` line at the top
docs/adr/003-record-architecture-decisions.md:43:  (Status is one of: Proposed, Accepted, Superseded by ADR-NNN,
docs/adr/003-record-architecture-decisions.md:44:  Deprecated, Rejected).
```

ADR-003's edit-in-place rule (the rule the fix arguably stretches):

```text
docs/adr/003-record-architecture-decisions.md:60:If a decision is later reversed, write a new ADR that
docs/adr/003-record-architecture-decisions.md:61:**Supersedes** the old one; do not edit the old ADR in place beyond
docs/adr/003-record-architecture-decisions.md:62:flipping its `Status` and adding a one-line pointer.
```

Source for the backdated value:

- `git log --diff-filter=A --format='%ad %h' --date=short -- docs/adr/001-structured-logging-with-pino.md` will produce the file-creation date (and is the only authoritative source — do not invent a date from sibling ADRs).

## Proposed resolution

Two options. Recommend **option A**.

**Option A — Add the `**Date**` line, backdated from `git log` (recommended).**

The edit is two lines of diff on `docs/adr/001-structured-logging-with-pino.md`:

```diff
 # ADR-001: Structured Logging with Pino and Correlation IDs

-**Status:** Accepted
+- **Date**: <YYYY-MM-DD from git log>
+- **Status**: Accepted
```

Match the bullet-list format ADR-002 onward already uses (note the dash + colon + space — ADR-001 currently uses bare `**Status:**`). The retroactive-compliance framing carries it: ADR-003 mandated the field; ADR-001 inadvertently shipped without it; the diff restores the mandated shape without changing any *decision* content.

Run `git log --diff-filter=A --format='%ad' --date=short -- docs/adr/001-structured-logging-with-pino.md` to source the date; do not infer it from sibling ADRs (they may have been written days later).

**Option B — Leave ADR-001 as-is and carve a narrow grandfather exception in ADR-003.**

If the strict edit-in-place reading wins, instead amend `docs/adr/003-record-architecture-decisions.md` §Decision with a one-line carve-out: "ADR-001 predates this ADR and is grandfathered without a `**Date**` line; future ADRs MUST include both fields." The trade-off is that this turns a one-file silent gap into a two-file documented gap — uglier surface area in exchange for a tighter no-edit-in-place rule. Weaker than option A.

## Scope

**In:**

- Edit `docs/adr/001-structured-logging-with-pino.md` header (option A), or
- Edit `docs/adr/003-record-architecture-decisions.md` to grandfather ADR-001 (option B).

**Out:**

- Any change to ADR-001's `## Context`, `## Decision`, `## Alternatives Considered`, or `## Consequences` sections.
- Any retroactive Date backfill on other ADRs (they already comply).
- Combining with epic-00 task-01 (the supersession-pointer fix) in one diff — keep the two concerns separate so reviewers can accept / reject each independently.

## Exit criteria

- [ ] Either ADR-001 has a `**Date**` line matching the bullet-list shape of ADR-002 onward (option A), or ADR-003 carries a one-line grandfather exception naming ADR-001 (option B).
- [ ] No other ADR's text was edited.
- [ ] `yarn lint` still passes.
- [ ] `tmp/adr-verification-progress.md` ADR-001 row reflects the resolution (already updated by task-01; this task adds a second pointer for the Date-line fix).
