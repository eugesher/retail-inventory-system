---
epic: epic-00
task_number: 19
title: Fix `epic-04/task-06` "two epochs" mis-citation of ADR-022 and ADR-023 §"transition window"
depends_on: []
doc_deliverable: null
---

# Task 19 — `epic-04/task-06` cites a non-existent "two epochs" transition-window rule in ADR-022 and ADR-023

## Required reading

- **Mandatory:** Read `tmp/adr-summary.md` before starting — the index of architectural decisions of record.
- **Recommended:** Open ADR-022 (especially §"4. Transition window for pre-v1 entries" at lines 144-169 — the operative paragraph quoted below — and the `## Consequences > Neutral / Follow-ups` block at lines 256-265) and ADR-023 (the full text — the document is short, and there is no §"transition window" section anywhere in it) in full before editing. ADR-003 §"When making an architectural decision, write an ADR" is the cadence reference if the implementer decides the stricter "two epochs" rule is genuinely wanted and chooses option B below.

## ADR audited

[ADR-022 — Cache-key schema-version and opt-in tenant segments](../../../docs/adr/022-cache-keys-tenant-and-schema-version.md) and [ADR-023 — Post-commit cache invalidation enforced by the type system](../../../docs/adr/023-cache-invalidate-post-commit-by-type.md). Both Accepted (2026-05-20).

## Contradiction

`tmp/tasks/epic-04-inventory-stock-level-and-location/task-06-bump-cache-key-version-v1-to-v2-rewrite-stock-cache.md` cites a "two epochs" transition-window rule at two places, attributing it once to ADR-023 and once to ADR-022. Neither ADR contains such a rule, neither ADR has a section titled "transition window" matching the citation wording, and neither defines a "two epochs" time-based criterion for retiring legacy invalidate prefixes.

`tmp/tasks/epic-04-…/task-06-…:41`:

> "`productStockPrefix(productId)` and `productStock(productId, …)` (the pre-ADR-016 legacy) stay — they continue to be wiped by the invalidate path for one more transition window (**the ADR-023 §'transition window' decision is 'keep wiping until two epochs have elapsed since the last write under the prefix'**; the v1 → v2 bump does not start the clock fresh on the pre-ADR-016 prefix)."

`tmp/tasks/epic-04-…/task-06-…:337`:

> "- **pre-bump v1** (`inventoryStockV1LegacyPrefix`) — `ris:inventory:stock:v1:<productId>:`. Invalidate-only via the startup drain. Will be removed after two deploy epochs (**cite the project's 'two epochs' rule from ADR-022 §'transition window'**)."

This instruction asserts false facts about Accepted ADRs and would, if followed, propagate the misattribution into the project's user-facing documentation (the doc deliverable that task-06 enumerates).

Surface: `tmp/tasks/epic-04-inventory-stock-level-and-location/task-06-bump-cache-key-version-v1-to-v2-rewrite-stock-cache.md:41` and `:337`.

## Evidence

The actual ADR-022 §"4. Transition window for pre-v1 entries" (`docs/adr/022-cache-keys-tenant-and-schema-version.md:144-169`) — quoted verbatim:

```text
A second transition window is layered on top of the existing ADR-016
one. `StockCache.invalidate` now fans out three `delByPrefix` calls
per productId:

1. **v1 prefix** — …
2. **Pre-v1 (post-ADR-016) prefix** — …
3. **Pre-ADR-016 legacy prefix** — `stock:<productId>:` …

The transition window for the v1 cut-over is **one rolling deploy**.
After the slowest replica has restarted onto v1 and at least one
invalidate has fired for each affected `productId`, the pre-v1 prefix
is unreachable from production code; any remaining entries age out
via TTL. The pre-v1 fan-out can be removed in a follow-up task once
the dashboards confirm zero pre-v1 hits.
```

And `docs/adr/022-cache-keys-tenant-and-schema-version.md:256-260` (Neutral / Follow-ups):

```text
- **Follow-up:** remove the pre-v1 `inventoryStockLegacyPrefix` wipe
  from `StockCache.invalidate` once dashboards (TBD instrumentation —
  hits-per-prefix counter) show zero hits for one full TTL.
```

ADR-022's actual retirement criterion is **"one rolling deploy + dashboards show zero hits for one full TTL"** — not "two epochs". The string "epoch" does not appear in ADR-022 at all (verified by grep):

```bash
$ grep -in 'epoch' docs/adr/022-cache-keys-tenant-and-schema-version.md
# (no output)
```

ADR-023 likewise has no §"transition window" section and no "epochs" rule. The closest paragraph (§"2. Implementation" at lines 113-117) describes the helper's prefix-fan-out body as "unchanged — only its visibility and entry point moved":

```text
docs/adr/023-cache-invalidate-post-commit-by-type.md:113-117:`apps/inventory-microservice/src/modules/stock/infrastructure/cache/stock.cache.ts`
implements `withInvalidation` by awaiting `work`, then conditionally
calling the private `invalidatePrefixes(items, opts)`. The
prefix-fan-out body (ADR-022 v1 + pre-v1 + pre-ADR-016 wipes) is
unchanged — only its visibility and entry point moved.
```

The string "epoch" does not appear in ADR-023 either:

```bash
$ grep -in 'epoch' docs/adr/023-cache-invalidate-post-commit-by-type.md
# (no output)
```

The string "epoch" does appear in `task-06` six times, but never in any ADR — task-06 is the lone source of the "two epochs" framing:

```bash
$ grep -in 'epoch' tmp/tasks/epic-04-inventory-stock-level-and-location/task-06-bump-cache-key-version-v1-to-v2-rewrite-stock-cache.md
41:  - …(the ADR-023 §"transition window" decision is "keep wiping until two epochs have elapsed since the last write under the prefix"; …
108:  // legacy entries (pre-v1 productId-keyed and pre-ADR-016 stock:<id>:) and
337:     - **pre-bump v1** … Will be removed after two deploy epochs (cite the project's "two epochs" rule from ADR-022 §"transition window").
```

## Why this matters

Two distinct failure modes if `task-06` ships as written:

1. **The doc deliverable propagates the false attribution.** Line 337 instructs the implementer to "cite the project's 'two epochs' rule from ADR-022 §'transition window'" inside the user-facing doc deliverable enumerated at the top of task-06. A future reader who follows the citation lands on ADR-022 §4 and finds "one rolling deploy" — not "two epochs". Trust in the ADR set erodes; the implementer now has to choose between "the docs are wrong" and "the ADR was edited without a Status flip" (a guaranteed wrong conclusion since ADR-003 forbids in-place ADR edits).

2. **The actual retirement criterion is stricter, not looser.** ADR-022 retires the pre-v1 fan-out after **one full TTL** of dashboard zero-hits — an *event-based* criterion (zero observed reads under the prefix) bounded by the cache TTL. Task-06's "two deploy epochs" is *time-based* and unmoored from observed behaviour. If the implementer follows task-06's invented rule, the pre-v1 wipe runs for longer than ADR-022 specified, paying the per-call SCAN cost beyond what the ADR mandates. Worse: if "epoch" gets pinned to a fixed calendar interval (e.g. one week per epoch) without dashboard instrumentation, the wipe could run indefinitely on a service that gets no traffic during the chosen window.

This is the same family of finding as `epic-00/task-11` (epic-01/task-10's "no new ADR is required" claim) — a decomposed task asserting a confident, citation-backed fact about an Accepted ADR that simply is not in the ADR's text.

## Proposed resolution

Two options. Recommend **option A**.

**Option A — Rewrite both citations in task-06 to match the actual ADR text (recommended).**

Edit `tmp/tasks/epic-04-inventory-stock-level-and-location/task-06-bump-cache-key-version-v1-to-v2-rewrite-stock-cache.md`:

- Line 41 — replace the parenthetical "the ADR-023 §'transition window' decision is 'keep wiping until two epochs have elapsed since the last write under the prefix'" with the actual ADR-022 rule: "ADR-022 §4 retires a legacy invalidate prefix after **one rolling deploy** has placed every replica on the new version *and* dashboards show zero hits under the prefix for one full TTL — the v1 → v2 bump does not start that clock fresh on the pre-ADR-016 prefix because the pre-ADR-016 prefix is independent of the v1/v2 cut-over." Cite ADR-022 §4 (not ADR-023).
- Line 337 — replace "Will be removed after two deploy epochs (cite the project's 'two epochs' rule from ADR-022 §'transition window')." with "Will be removed once dashboards show zero hits under `ris:inventory:stock:v1:*` for one full TTL after the rolling deploy completes — the criterion documented in ADR-022 §4 and §'Neutral / Follow-ups'."

The startup-drain mechanism task-06 introduces (the `CACHE_DRAIN_LEGACY_ON_BOOT` flag at lines 53-54) is a separate decision from when the *flag itself* is retired, and the flag-retirement criterion is what these two citations are trying to anchor. ADR-022 §4's "one rolling deploy + dashboards-zero-for-one-TTL" rule applies cleanly to the flag's lifecycle: keep the flag on until dashboards confirm zero v1 hits for one TTL window, then remove the flag in a follow-up task.

**Option B — Write a new ADR introducing the "two epochs" rule, then update task-06's citations to point at it.**

If the implementer genuinely wants a stricter, time-based retirement criterion (e.g. "two deploy epochs" as a calendar interval), ADR-003 cadence applies: introduce ADR-024 "Legacy cache-prefix retirement: two-deploy-epoch rule", state the time-based criterion, explain why it is stricter than ADR-022 §4's event-based rule, then update task-06 §41 + §337 to cite ADR-024 instead. ADR-022 stays as is; the new ADR layers on top.

Recommend option A. The "two epochs" framing reads like a default the author assumed was in the ADR set rather than a deliberate stricter rule the author wanted to introduce; option A returns task-06 to the correct citation without inventing new architectural rules.

## Scope

**In:**

- Edit `tmp/tasks/epic-04-inventory-stock-level-and-location/task-06-bump-cache-key-version-v1-to-v2-rewrite-stock-cache.md:41` and `:337` to match the actual ADR-022 §4 text (option A), or
- Allocate ADR-024 + author it as the source of the "two epochs" rule + update task-06 §41 / §337 to cite ADR-024 instead of ADR-022 / ADR-023 (option B).

**Out:**

- Any change to ADR-022 (the supersession-pointer edit for ADR-022 is filed separately under `epic-00/task-18` and is unrelated to this task).
- Any change to ADR-023.
- Any change to the rest of task-06 — only the two citation strings at lines 41 and 337 need amendment under option A. The startup-drain mechanism, the renamed builders, the v2 key shape, and the `withInvalidation`-preserving `StockCache` rewrite all stand as task-06 already describes them.
- Any change to other epic-04 tasks. The "two epochs" string does not appear in any other task file (verified by `grep -rn 'epoch' tmp/tasks/`).

## Exit criteria

- [ ] `grep -n 'epoch' tmp/tasks/epic-04-inventory-stock-level-and-location/task-06-…md` returns either zero hits (option A) or only hits backed by a citation to ADR-024 (option B).
- [ ] Lines 41 and 337 of task-06 cite a real ADR section that is verifiable by `grep -n` against the cited ADR file.
- [ ] The doc deliverable enumerated at the top of task-06 carries the corrected citation, not the "two epochs" one.
- [ ] `tmp/adr-verification-progress.md` ADR-022 + ADR-023 rows are updated to `HAS-CORRECTIONS` with a pointer back to this task (ADR-022 also points at `epic-00/task-18`; ADR-023's HAS-CORRECTIONS marker is solely from this task).
