# Cleanup summary — migration-plan + RIS-25 references

Date: 2026-05-18
Branch: `RIS-39-Architecture-migration-Phase-15-Cleanup-migration-plan-references`

---

## Removed references

| File | Line (pre-edit) | Original snippet | Action |
|------|-----------------|------------------|--------|
| `README.md` | 9 | "`[`docs/architecture-migration-plan/parts/`](docs/architecture-migration-plan/parts/) holds the original recommendation document and project audit as a historical record.`" — final sentence of the paragraph | **delete** — removed the trailing sentence; the preceding "ADRs are the durable record" sentence carries the load |
| `CLAUDE.md` | 239 | "The recommendation document that drove the per-module hexagonal migration is preserved at `[…/recommendation.md](…)` for historical reference." | **delete** — removed the sentence; rest of paragraph (ADRs as durable record, next free ADR number) reads cleanly without it |
| `docs/adr/004-adopt-hexagonal-architecture-per-service.md` | 29–39 (Context paragraph) | "The migration plan `[…/recommendation.md](…)` identifies hexagonal architecture (Ports & Adapters) as the target pattern and dedicates Sections 1–3 to motivating it: …" | **replace** — kept the rationale inline; replaced the dead link with "The pre-migration recommendation that drove this work identified …"; rewired the trailing "architecture-lint enforcement … is task-12" to point at ADR-017 |
| `docs/adr/004-adopt-hexagonal-architecture-per-service.md` | 78–80 (Decision, "Per-module layout") | "specified in `[recommendation.md Section 3 …](…)` and Section 4" | **replace** — pointed the reader at `CLAUDE.md`'s "Forbidden imports" paragraph and ADR-017 instead |
| `docs/adr/004-adopt-hexagonal-architecture-per-service.md` | 120–121 (Alternatives) | "**Awesome Nest Boilerplate / Tony133 (flat layout).** Rejected per `[recommendation.md Section 1](…)`: …" | **replace** — dropped "per recommendation.md Section 1"; the rest of the rejection rationale (`both are flat …`) was already self-contained |
| `docs/adr/005-split-shared-common-into-bounded-libs.md` | 241–243 (References) | "`[…/recommendation.md](…)` — Section 7 ("Library re-mapping") motivates the exact lib names …" | **delete** — removed the bullet from the References list; remaining bullets (ADR-004, -018, -019) cover the durable references |
| `docs/adr/005-split-shared-common-into-bounded-libs.md` | 251–252 (References) | "`[…/task-03-extract-shared-libs-foundation.md](…)` — the task that executes the structural move …" | **delete** — removed the bullet; the task executed long ago and the ADR records the decision |
| `docs/adr/009-port-adapter-at-the-gateway.md` | 41–46 (Context) | "The migration recommendation (`[…/recommendation.md](…)` §5) explicitly forbids `ClientProxy` injection from a controller …" | **replace** — preserved the rule; rewired the reader to `CLAUDE.md`'s "Boundary rule" paragraph and ADR-017 |
| `docs/adr/017-architecture-lint-via-eslint-boundaries.md` | 10 (Context) | "documented in §3 of `[…/recommendation.md](…)` and reinforced in `CLAUDE.md` as the 'Forbidden imports' paragraph" | **replace** — kept the `CLAUDE.md` pointer; removed the dead-doc reference |

**Totals: 9 references actioned — 4 deletes, 5 replaces.**

---

## ADR edits (step 3 — branch identifier stripping)

### `docs/adr/003-record-architecture-decisions.md`

- Lines 12–14 edited.
- Before: "…and now a full hexagonal-architecture migration starting on branch `RIS-25-Architecture-migration` — that the *why* behind each choice has started leaking…"
- After: "…and the full hexagonal-architecture migration that began around the time this ADR was written — that the *why* behind each choice has started leaking…"
- No `updated:` frontmatter field present (ADR has only `**Date**` and `**Status**` lines), so nothing to bump.
- Why this phrasing: ADR-003 was dated 2026-05-08 while the migration ran through 2026-05-15. Pinning a single month inside the ADR would misrepresent the timeline; "around the time this ADR was written" preserves the historical anchor without inventing precision.

### `docs/adr/004-adopt-hexagonal-architecture-per-service.md`

- Line 14 edited (this is in addition to the three step-2 replacements logged above).
- Before: "…(already partially in place on `RIS-25-Architecture-migration`), but the lack of a port/adapter inversion means that:"
- After: "…(already partially in place at the start of the architecture migration), but the lack of a port/adapter inversion means that:"
- No `updated:` frontmatter field, so nothing to bump.

---

## Deleted folder

- `docs/architecture-migration-plan/` removed entirely (`rm -rf`).
- Files inside before deletion: **34** (captured pre-deletion via `find docs/architecture-migration-plan -type f | wc -l`).
- Verification: `ls docs/` now shows only `adr`, `audits`, `baseline`.

---

## Verification results

| Command | Status | Notes |
|---------|--------|-------|
| `yarn install --frozen-lockfile` | ✅ pass | "Done in 3s 271ms" (Yarn 4.12.0). Berry deprecates `--frozen-lockfile` in favour of `--immutable`; warning only, not a failure. |
| `yarn build` | ✅ pass | 4 apps compiled (api-gateway, inventory-microservice, retail-microservice, notification-microservice) via webpack 5.106. |
| `yarn lint` | ✅ pass | `max-warnings 0` — exit 0. |
| `yarn test:unit` | ✅ pass | 29 suites, 152 tests, all green. Jest emitted the routine "worker process did not exit gracefully" warning; this is a known teardown issue unrelated to this change. |

Status: **GREEN**.

---

## Anything unexpected

1. **ADR-004 also had a bare-text reference to "Section 7 of `recommendation.md`"** at line 146 (inside Alternatives Considered, "Per-bounded-context monorepo with shared `core` library"). It's not a markdown link and doesn't match `architecture-migration-plan` in the grep, so it didn't surface in the inventory. The brief specifies that ADR content edits beyond step 2 and step 3 are out of scope, so I left it untouched. **Worth a glance from a human reviewer** — it's now a dangling bare-text reference to a doc that no longer exists. The sentence "Section 7 of `recommendation.md` lists these libs as 'already correct, preserve as-is' …" still reads as historical commentary, so it isn't broken in the link-checker sense, but it could be reworded later if desired.

2. **No working notes / personal docs touched.** The repo root contains `a.md`, `http.md`, `nvim.md`, `task.md`, plus the `http/` folder. None matched either search term; all are untracked. Left alone.

3. **`docs/architecture-migration-ru/` not present** on this branch, as the brief anticipated. No defensive action needed.

4. **No code-comment hits anywhere** in `apps/**`, `libs/**`, `migrations/`, `scripts/`, `tools/`, or root config files. All cleanup landed in markdown.

5. **`.github/` and `.husky/` not inspected** per the explicit out-of-scope rule. The cleanup did not enter those folders. If either contains a reference (unlikely but possible), it survives this task.

---

## Outputs

- Edited: 6 files (README.md, CLAUDE.md, ADRs 003, 004, 005, 009, 017 — 7 files actually).
- Deleted: `docs/architecture-migration-plan/` (34 files).
- Temp files: `_cleanup-inventory.txt` will be removed in the final step.

Counts:
- 4 references removed
- 5 references replaced
- 2 ADR sentences edited to strip the branch identifier
- Verification: ✅ install / ✅ build / ✅ lint / ✅ unit tests
