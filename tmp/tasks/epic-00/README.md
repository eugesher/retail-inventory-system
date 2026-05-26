---
epic: epic-00
source_audit: tmp/adr-verification-progress.md
---

# Epic 00 — ADR-Accuracy Corrections

Holds correction tasks filed by the resumable ADR-verification audit driven by `tmp/adr-verification-progress.md`. Each task addresses one **CODE-DISCREPANCY** (the codebase or the ADR set itself contradicts an Accepted ADR's claim) or one **TASK-CONTRADICTION** (a decomposed task under `tmp/tasks/epic-NN-*` instructs something that contradicts an Accepted ADR's binding rule).

These tasks are **doc / metadata edits**, not feature work — they do not change application behaviour. They land independently of any epic and can be picked up in any order.

## Conventions

- Each task names the ADR being audited, the surface where the discrepancy lives (`docs/adr/...` for code-discrepancies in ADR prose, `tmp/tasks/epic-NN-*/task-NN-*.md` for task-contradictions), the evidence (path:line + quote), and a proposed resolution.
- The resolution may be: amend the ADR (add a one-line supersession pointer; flip Status to `Superseded in part by ADR-NNN`), fix the offending task body, or — when the ADR itself is the thing that is wrong — write a new ADR that supersedes it. Each task recommends one path and leaves the final call to the implementer.
- ADR text edits MUST respect [ADR-003](../../../docs/adr/003-record-architecture-decisions.md): "Never edit a prior ADR in place beyond flipping its `Status` and adding a one-line supersession pointer." Anything beyond that requires a new ADR.

## Sequence and dependencies

Tasks under this epic are **mutually independent**. Pick them in any order.

| #   | Task                                                                                                                 | Touches               | ADR audited |
| --- | -------------------------------------------------------------------------------------------------------------------- | --------------------- | ----------- |
| 01  | [Add ADR-001 supersession pointer for logger-config relocation](task-01-adr-001-add-supersession-pointer-for-logger-relocation.md) | `docs/adr/001-…md`    | ADR-001     |
| 02  | [Add ADR-002 supersession pointer for cache-aside evolution](task-02-adr-002-add-supersession-pointer-for-cache-evolution.md)       | `docs/adr/002-…md`    | ADR-002     |
| 03  | [Add `**Date**` header to ADR-001](task-03-adr-001-add-date-header.md)                                                              | `docs/adr/001-…md`    | ADR-001 / ADR-003 |
| 04  | [Correct ADR-004's ports location — `domain/ports/` → `application/ports/`](task-04-adr-004-correct-ports-location-from-domain-to-application.md) | `docs/adr/004-…md`    | ADR-004     |
| 05  | [Add ADR-006 supersession pointer for port-surface + key-shape evolution](task-05-adr-006-add-supersession-pointer-for-port-surface-and-key-shape-evolution.md) | `docs/adr/006-…md`    | ADR-006     |

## Provenance

- Audit driver: the verification protocol invoked via the user's `/loop`-style prompt that produced `tmp/adr-verification-progress.md`. Each task's "Evidence" block quotes the grep output / file:line that justified the finding.
- ADR-summary digest under `tmp/adr-summary.md` is the canonical short-form catalog implementers must read before starting any of these tasks.
