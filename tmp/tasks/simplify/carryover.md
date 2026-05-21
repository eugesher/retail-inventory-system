# Simplification Carryover

This document is the **only shared state** across clean-context simplification phases. Each phase reads it on entry and updates it on exit. Treat all content here as load-bearing; do not delete entries from prior phases.

## How to use this document
- On phase entry: read every section in full.
- "Established patterns" is normative — apply listed conventions consistently in your phase.
- "Files modified" tells you what has already been touched; do not re-simplify out of scope.
- "Open / deferred" is a working triage list; consult it for items that may be in your phase's scope.
- On phase exit: update the relevant sections per your task file's Procedure step 5. Do not remove prior entries.

## Phase ledger
### Completed
_(initially empty)_

### Pending
- phase-01 — foundational-libs
- phase-02 — infrastructure-libs
- phase-03 — notification-microservice
- phase-04 — inventory-microservice
- phase-05 — retail-microservice
- phase-06 — api-gateway
- phase-07 — tests-and-scripts

## Established patterns
_(initially empty; phases append cross-phase conventions worth applying consistently — e.g., "controller methods return DTOs, not entities", "use constructor injection only", "RabbitMQ handlers live in `messaging/` subfolder")_

## Files modified by phase
### phase-01
_(initially empty)_
### phase-02
_(initially empty)_
### phase-03
_(initially empty)_
### phase-04
_(initially empty)_
### phase-05
_(initially empty)_
### phase-06
_(initially empty)_
### phase-07
_(initially empty)_

## Test status checkpoints
### phase-01
_(initially empty; record: which test commands ran, pass/fail counts, notable skipped tests)_
### phase-02
_(initially empty)_
### phase-03
_(initially empty)_
### phase-04
_(initially empty)_
### phase-05
_(initially empty)_
### phase-06
_(initially empty)_
### phase-07
_(initially empty)_

## Open / deferred
_(initially empty; append items the skill could not simplify within its contract, items deferred to a later phase, or human-triage items)_
