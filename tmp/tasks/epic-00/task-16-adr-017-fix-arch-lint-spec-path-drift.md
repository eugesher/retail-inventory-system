---
epic: epic-00
task_number: 16
title: Correct ADR-017's architecture-lint spec path — `tests/lint/architecture-lint.spec.ts` → `spec/architecture-lint.spec.ts`
depends_on: []
doc_deliverable: null
---

# Task 16 — Correct ADR-017's architecture-lint spec path drift

## Required reading

- **Mandatory:** Read `tmp/adr-summary.md` before starting — the index of architectural decisions of record.
- **Recommended:** For any decision relevant to this task, open the linked original ADR under `docs/adr/` before implementing. In particular, read ADR-017 §7 ("Regression test") and ADR-003 in full before deciding the wording. The live `eslint.config.mjs` file-pattern blocks and the actual `spec/architecture-lint.spec.ts` are the source of truth for the path.

## ADR audited

[ADR-017 — Architecture lint via `eslint-plugin-boundaries`](../../../docs/adr/017-architecture-lint-via-eslint-boundaries.md). Accepted (2026-05-14).

## Discrepancy

ADR-017 §7 ("Regression test") describes the architecture-lint fixture spec at two specific locations that no longer match the codebase:

1. **Spec path.** ADR-017 line 102 says the spec lives at `tests/lint/architecture-lint.spec.ts`. The live file is `spec/architecture-lint.spec.ts` (no `tests/` directory exists at repo root). Every other place in the codebase that references the spec — every decomposed task under `tmp/tasks/**`, the `eslint.config.mjs` ignore block, the repo's lint scope — uses the `spec/` path. ADR-017 §7 is the only outlier.
2. **Lint relaxation block path.** ADR-017 line 111 says the spec is added to lint scope "via the `tests/**/*.ts` relaxation block in `eslint.config.mjs` (same shape as the existing `test/**/*.ts` relaxation)." The live config carries no `tests/**/*.ts` relaxation block — `eslint.config.mjs:535` defines `files: ['test/**/*.ts', 'spec/**/*.ts']` (the `spec/` glob is what actually scopes the spec into the relaxation, not a separate `tests/` glob).

Both items are path-drift, not architectural drift. The rule and the regression-spec mechanism work exactly as ADR-017 describes — only the filesystem locations the ADR cites are stale.

The path-drift is also mirrored in CLAUDE.md §"Architecture rules location" (which references `tests/lint/architecture-lint.spec.ts`), but CLAUDE.md correction is out of scope here — file separately if desired.

Surface: `docs/adr/017-architecture-lint-via-eslint-boundaries.md` (the ADR prose itself).

## Evidence

ADR-017 prose cites the wrong paths:

```text
docs/adr/017-architecture-lint-via-eslint-boundaries.md:102:`tests/lint/architecture-lint.spec.ts` runs ESLint's `Linter` programmatically against hand-crafted fixture source strings, asserting that each rule fires the expected `boundaries/dependencies` ruleId. It covers:
docs/adr/017-architecture-lint-via-eslint-boundaries.md:111:The spec is added to `apps/**/*.ts` + `libs/**/*.ts` lint scope via the `tests/**/*.ts` relaxation block in `eslint.config.mjs` (same shape as the existing `test/**/*.ts` relaxation), so the strict typing rules don't fire on the fixture source strings.
```

Real layout (verified by `find /home/eugesher/dev/job/retail-inventory-system -name 'architecture-lint*'`):

```text
spec/architecture-lint.spec.ts              # the actual file — at repo root under `spec/`, not `tests/lint/`
```

Live relaxation block (`eslint.config.mjs:535`):

```text
eslint.config.mjs:535:    files: ['test/**/*.ts', 'spec/**/*.ts'],   # the spec is in scope via the `spec/**/*.ts` glob, not a non-existent `tests/**/*.ts` block
```

Every decomposed task that touches the spec uses the correct path:

```text
tmp/tasks/epic-01-baseline-identity-staffuser-customer-rbac/README.md:25:        | … `spec/architecture-lint.spec.ts` |
tmp/tasks/epic-01-baseline-identity-staffuser-customer-rbac/task-10-documentation-pass-readme-claudemd-arch-lint.md:9:    # Task 10 — Documentation pass (`README.md`, `CLAUDE.md`, `spec/architecture-lint.spec.ts`)
tmp/tasks/epic-02-catalog-product-and-variant/README.md:24:        | … `spec/architecture-lint.spec.ts` |
tmp/tasks/epic-03-pricing-price-and-tax-category/README.md:16:        | … `spec/architecture-lint.spec.ts` |
tmp/tasks/epic-03-pricing-price-and-tax-category/task-01-pricing-module-scaffold.md:31:- `spec/architecture-lint.spec.ts` has a `describe('catalog-microservice fixtures', ...)` block added by epic-02 task-01.
tmp/tasks/epic-04-inventory-stock-level-and-location/README.md:25:        | … `spec/architecture-lint.spec.ts` |
```

A `find` for any `tests/` directory or `tests/lint/architecture-lint.spec.ts` file returns nothing — the `tests/` path tree does not exist in this repo.

## Why this matters

ADR-017 §7 is the load-bearing description of the regression test that guards the boundary rules. An implementer who lands on ADR-017 and tries to follow §7 literally will:

1. Look for `tests/lint/architecture-lint.spec.ts` and not find it. Best case, they grep around and converge on the real location. Worst case, they conclude the spec was deleted and rebuild it under `tests/lint/` — diverging the regression-coverage surface across two file paths.
2. Look for a `tests/**/*.ts` block in `eslint.config.mjs` and not find it. The strict typing rules they expect to be relaxed for fixture source strings appear to be unrelaxed — they may add a `tests/**/*.ts` glob that scopes nothing, or weaken the `spec/**/*.ts` relaxation, both of which create non-obvious lint regressions.

ADR-017 is the rule-set that the whole architecture-lint discipline depends on. A reader misled by stale paths inside it loses confidence in the file as the authoritative reference for the lint surface.

## Proposed resolution

Two options. Recommend **option A**.

**Option A — Amend ADR-017 §7 in place to cite the live paths (recommended).**

The ADR-003 immutability rule (line 62) reserves in-place edits for `Status` flips and one-line supersession pointers. A pure path-correctness fix is the narrow class of edit where the original ADR is *not* superseded — the decision, the mechanism, and the coverage matrix all stand; only the path strings are wrong. This is the same class of edit as ADR-007's example-log-shape correction (`epic-00/task-06`), which amends a wrong literal inside the ADR body without changing the decision.

Concrete edits:

- Line 102: `tests/lint/architecture-lint.spec.ts` → `spec/architecture-lint.spec.ts`.
- Line 111: replace "via the `tests/**/*.ts` relaxation block in `eslint.config.mjs` (same shape as the existing `test/**/*.ts` relaxation)" with "via the `spec/**/*.ts` glob inside the `files: ['test/**/*.ts', 'spec/**/*.ts']` relaxation block in `eslint.config.mjs`". This both names the live block correctly and keeps the rationale ("so the strict typing rules don't fire on the fixture source strings") intact.

No Status flip is needed — the ADR's decision and architecture are unchanged; only the path literals are corrected.

If the implementer prefers to gate this under ADR-003's letter rather than its spirit, the safe alternative is to *also* add a `**Status**: Accepted (§7 path literals amended on YYYY-MM-DD; mechanism unchanged)` note alongside the path fixes. Either reading complies with ADR-003 — the prohibition is on **rewriting decisions in place**, not on correcting wrong literals that misdirect a reader.

**Option B — Move the spec to `tests/lint/architecture-lint.spec.ts` to match ADR-017.**

Rejected as the recommendation but listed for completeness. Would require: (a) renaming `spec/architecture-lint.spec.ts` to `tests/lint/architecture-lint.spec.ts`; (b) updating every task under `tmp/tasks/**` that cites the `spec/` path (six task files); (c) adding a new `tests/**/*.ts` glob to the `eslint.config.mjs` relaxation block; (d) updating CLAUDE.md §"Architecture rules location". Disproportionate to a documentation-side path drift — the `spec/` location was load-bearing for the whole migration's task carryover, and reversing it would create the exact same drift in the opposite direction.

## Scope

**In:**

- Edit `docs/adr/017-architecture-lint-via-eslint-boundaries.md` §7 lines 102 and 111 to cite `spec/architecture-lint.spec.ts` and the `spec/**/*.ts` glob inside the existing `files: ['test/**/*.ts', 'spec/**/*.ts']` relaxation block (option A).

**Out:**

- Moving the actual spec file (option B).
- Any change to `eslint.config.mjs` (the relaxation block is already correct; only the ADR's description of it is wrong).
- Any change to CLAUDE.md (it mirrors the wrong path in §"Architecture rules location" and §"Operational notes"; file separately if desired — see "Side-finding" below).
- Any change to ADR-017's other sections (the element-type taxonomy, the dependency rules, the `ARCH-LINT-EX-01` closure narrative, the CI strategy — all match live code).
- Updating the `lib-shim` table entry in §2 — ADR-017's own §"Open" line already notes that the shim element type will retire alongside the shim libs; the shim retirement is a self-acknowledged future state.

## Exit criteria

- [ ] A reader landing on ADR-017 §7 finds the spec at the path the ADR cites.
- [ ] The relaxation-block description in ADR-017 §7 matches the live `eslint.config.mjs` block.
- [ ] No other ADR's text was edited beyond what the resolution requires.
- [ ] `yarn lint` still passes (touching only `docs/adr/*.md` should be a no-op for lint).
- [ ] `tmp/adr-verification-progress.md` ADR-017 row is updated to `HAS-CORRECTIONS` with a pointer back to this task.

## Side-finding (out of scope for this task)

CLAUDE.md §"Architecture rules location" — "The bumper next to it is `tests/lint/architecture-lint.spec.ts`" — mirrors the same stale path. CLAUDE.md is the live authority on the codebase shape and is not subject to ADR-003's immutability rule, so a fix there is a straightforward in-place edit, but it should be filed as its own task (or rolled into a future CLAUDE.md grooming pass) rather than landed here, to keep the surface of this task narrow to ADR text.
