---
epic: epic-00
task_number: 1
title: Add ADR-001 supersession pointer for the logger-config relocation to `libs/observability/`
depends_on: []
doc_deliverable: null
---

# Task 01 — Add an ADR-001 supersession pointer for the logger-config relocation

## Required reading

- **Mandatory:** Read `tmp/adr-summary.md` before starting — the index of architectural decisions of record.
- **Recommended:** For any decision relevant to this task, open the linked original ADR under `docs/adr/` before implementing. In particular, read ADR-001, ADR-003, ADR-005, and ADR-007 in full before deciding the wording of the pointer.

## ADR audited

[ADR-001 — Structured Logging with Pino and Correlation IDs](../../../docs/adr/001-structured-logging-with-pino.md). Accepted.

## Discrepancy

ADR-001's `## Decision` block (lines 33-39) locates the logger configuration at `libs/config/logger/logger.config.ts` as a `LoggerConfig` class. That path no longer exists in the codebase — the logger configuration was moved into `libs/observability/` as part of the bounded-libs split (ADR-005) and the Pino + OTel co-location decision (ADR-007).

Surface: `docs/adr/001-structured-logging-with-pino.md` (the ADR prose itself).

ADR-001's Status field still reads `Accepted` with no supersession pointer; a future reader landing on it has no signal that the cited path is stale.

## Evidence

ADR-001 prose still cites the original path:

```text
docs/adr/001-structured-logging-with-pino.md:33:**Logger configuration** is centralised in `libs/config/logger/logger.config.ts` as a `LoggerConfig` class that implements the `nestjs-pino` `Params` interface.
```

Real location (verified by `find libs/observability -type f -name "*.ts"`):

```text
libs/observability/logger.module.ts          # the LoggerModuleConfig class implementing nestjs-pino Params
```

No file under `libs/config/logger/` exists today (verified by `find libs/config -type f -name "*.ts"` — only `libs/config/config-module.config.ts` + `libs/config/index.ts`).

## Why this matters

ADR-001 is the project's foundational logging ADR and the digest at `tmp/adr-summary.md` explicitly tells task executors to "open the linked original ADR before implementing." An implementer who follows that instruction lands on a Decision section whose key file path is wrong, with no signal that the rest of the decision still holds. The risk is wasted exploration time or — worse — a new `libs/config/logger/` directory being created to "restore" the documented location.

## Proposed resolution

Two options. Recommend **option A**.

**Option A — Amend ADR-001 with a one-line supersession pointer (recommended).**

ADR-003 line 62 permits "flipping its `Status` and adding a one-line pointer." Use that allowance to land a minimal edit on `docs/adr/001-structured-logging-with-pino.md`:

- Replace `**Status:** Accepted` with `**Status:** Accepted (logger relocation superseded in part by ADR-005 / ADR-007 — see References)`.
- Add a `## References` section at the bottom of the file (parallel to ADR-002's References section) with two bullet points:
  - `[ADR-005](005-split-shared-common-into-bounded-libs.md) — splits `libs/common` into bounded libs; logger config moves out of `libs/config/`.`
  - `[ADR-007](007-pino-and-opentelemetry.md) — co-locates Pino with OpenTelemetry in `libs/observability/`; the file referenced as `libs/config/logger/logger.config.ts` is now `libs/observability/logger.module.ts`.`

Do **not** rewrite the body of ADR-001's Decision section. The body stands as the historical record of the original decision; the supersession pointer + references redirect the reader to the current state.

**Option B — Amend ADR-005 / ADR-007 with a back-reference instead.**

If you decide that even the Status-line edit goes too far for an ADR-001-style "first foundational ADR" file, alternatively add an explicit "Supersedes ADR-001 §Decision (logger location)" line in ADR-005 and ADR-007 — and accept that ADR-001's prose stays stale unless a reader walks the forward-reference graph. Weaker than option A.

## Scope

**In:**

- Edit `docs/adr/001-structured-logging-with-pino.md` Status line + add `## References` section (option A), or
- Edit `docs/adr/005-…md` and `docs/adr/007-…md` to add a "Supersedes ADR-001 §Decision (logger location)" line (option B).

**Out:**

- Any change to logger code under `libs/observability/`.
- Any change to ADR-002 (filed separately under epic-00 task-02).
- Any rewrite of ADR-001's `## Decision` body.

## Exit criteria

- [ ] A reader landing on ADR-001 sees an explicit signal that the cited file path is stale and where the current location is.
- [ ] No other ADR's text was edited beyond what the resolution requires.
- [ ] `yarn lint` still passes (touching only `docs/adr/*.md` should be a no-op for lint).
- [ ] `tmp/adr-verification-progress.md` ADR-001 row is updated to `HAS-CORRECTIONS` with a pointer back to this task.
