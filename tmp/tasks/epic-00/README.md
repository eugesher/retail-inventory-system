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
| 06  | [Amend ADR-007 example log shape (`trace_id` → `traceId`) + fold stale `task-10 fills body` narrative](task-06-adr-007-fix-example-log-shape-trace-id-camel-case.md) | `docs/adr/007-…md`    | ADR-007     |
| 07  | [Fold ADR-008 stale narrative (Notification client module + table scope)](task-07-adr-008-add-references-section-and-fold-notification-client-module-stale-narrative.md) | `docs/adr/008-…md`    | ADR-008     |
| 08  | [Fix `epic-02/task-01` app-local `otel.setup.ts` (ADR-007 host-rule violation)](task-08-epic-02-task-01-otel-setup-violates-libs-observability-host-rule.md) | `tmp/tasks/epic-02-…/task-01-…md` + `task-09-…md` | ADR-007     |
| 09  | [Fix `epic-03/task-03` legacy-enum usage (ADR-008 new-callers rule)](task-09-epic-03-task-03-pricing-replace-legacy-enum-with-routing-keys.md) | `tmp/tasks/epic-03-…/task-03-…md` | ADR-008     |
| 10  | [Fix `epic-04/task-07` `ClientProxy` in use-case (collapse with task-08)](task-10-epic-04-task-07-08-collapse-clientproxy-use-case-into-publisher-port.md) | `tmp/tasks/epic-04-…/task-07-…md` + `task-08-…md` | ADR-008     |
| 11  | [Fix `epic-01/task-10` "no new ADR is required" claim — RBAC v2 supersedes ADR-010](task-11-epic-01-task-10-rbac-claims-no-new-adr-but-supersedes-adr-010.md) | `tmp/tasks/epic-01-…/task-10-…md` | ADR-010     |
| 12  | [Add ADR-012 supersession pointer for `StockCache` port + adapter evolution (ADR-016/021/022/023 + `ITransactionPort`)](task-12-adr-012-add-supersession-pointer-for-stock-cache-port-and-adapter-evolution.md) | `docs/adr/012-…md`    | ADR-012     |
| 13  | [Correct ADR-013's `IOrderRepositoryPort` method list — 5 listed vs. 8 in live code](task-13-adr-013-fix-order-repository-port-method-list-drift.md) | `docs/adr/013-…md`    | ADR-013     |
| 14  | [Correct ADR-015's `instrumentation-pino` "not installed" claim](task-14-adr-015-correct-instrumentation-pino-installation-claim.md) | `docs/adr/015-…md`    | ADR-015     |
| 15  | [Add ADR-016 supersession pointer for key-shape, port-surface, invalidation evolution (ADR-021/022/023)](task-15-adr-016-add-supersession-pointer-for-key-shape-port-and-invalidation-evolution.md) | `docs/adr/016-…md`    | ADR-016     |
| 16  | [Correct ADR-017 architecture-lint spec path drift (`tests/lint/` → `spec/`)](task-16-adr-017-fix-arch-lint-spec-path-drift.md) | `docs/adr/017-…md`    | ADR-017     |
| 17  | [Reconcile ADR-019 — `TypeOrmModule.forFeature(...)` vs. `DatabaseModule.forFeature(...)` at infrastructure-module layer](task-17-adr-019-reconcile-typeorm-vs-database-module-for-feature.md) | `docs/adr/019-…md`    | ADR-019     |

## Provenance

- Audit driver: the verification protocol invoked via the user's `/loop`-style prompt that produced `tmp/adr-verification-progress.md`. Each task's "Evidence" block quotes the grep output / file:line that justified the finding.
- ADR-summary digest under `tmp/adr-summary.md` is the canonical short-form catalog implementers must read before starting any of these tasks.
