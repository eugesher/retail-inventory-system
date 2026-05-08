# task-13 — Back-fill structural architecture ADRs (Phase 7, ADRs)

## Context

- Migration plan: `docs/architecture-migration-plan/parts/recommendation.md`
- Conventions preamble: `docs/architecture-migration-plan/tasks/task-01-review-project-and-update-plan.md`
- Previous carryover: `docs/architecture-migration-plan/tasks/_carryover-12.md`
- Project conventions: `CLAUDE.md`
- Where we are in the migration: every code change is in. ADRs
  accumulated incrementally — task-01 created **003**
  (record-architecture-decisions), task-02 created **004**
  (adopt-hexagonal), task-03 created **005**
  (split-shared-common-into-bounded-libs), task-04 created
  three (cache-aside-via-libs-cache, pino-and-opentelemetry,
  rabbitmq-via-libs-messaging), task-05 created
  (port-adapter-at-the-gateway), task-06 created
  (jwt-rbac-at-the-gateway), task-07 created
  (notifier-port-and-adapters), task-08 created
  (stock-aggregate-and-port-adapter), task-09 created
  (order-aggregate-and-cross-service-confirm), task-10 created
  (otel-exporter-otlp-http-and-jaeger), task-11 created
  (cache-aside-generalized), task-12 created
  (architecture-lint-via-eslint-boundaries). This task fills the
  remaining structural gaps, reconciles cross-references, and
  produces the ADR index. **3-digit padding** is the locked
  convention from `_carryover-01.md`.

## Prerequisites

- [ ] `_carryover-12.md` exists and was read first.
- [ ] Build is green on entry.
- [ ] All earlier task carryovers list the ADRs they created.

## Goal

End up with a complete, consistent, indexable ADR set under
`docs/adr/`. Every architectural decision the migration encoded
— monorepo layout, hexagonal per-service, TypeORM-as-persistence,
RabbitMQ-as-bus, Redis cache-aside, Pino+OTel observability,
JWT/RBAC at the gateway, eslint-plugin-boundaries as the
architecture lint, the contracts/ddd/database lib split — is
either already an ADR or is added here. The existing **001**
(Pino) and **002** (Redis cache-aside) keep their numbers and
status; older entries are not renumbered.

## Steps

1. **Audit existing ADRs.** List every file under `docs/adr/`. For
   each, capture: number, title, status, date, decision summary.
   Save the audit as a table in `_carryover-13.md`.

2. **Identify structural gaps.** Compare the audit against the
   target catalogue:
   - **Monorepo with apps + libs** — likely missing if no earlier
     task wrote it. The `nest-cli.json monorepo: true` decision is
     load-bearing for everything below.
   - **TypeORM + MySQL as persistence** — likely missing.
     ADR documents the choice over alternatives (Prisma,
     ObjectionJS) and the snake-case column naming convention.
   - **RabbitMQ as inter-service bus** — likely missing as a
     pure transport ADR (the routing-keys-via-libs-messaging ADR
     covers the conventions, not the choice itself).
   - **Contracts / DDD / Database lib split** — captured in
     task-03's ADR-005, but verify it covers the **rationale** for
     splitting (why this split shape rather than alternatives).

3. **Add missing ADRs.** Each new ADR uses the existing project
   format (Nygard hybrid: Status, Context, Decision, Alternatives,
   Consequences — matching ADR-001 and ADR-002). Status: Accepted;
   date today.

4. **Cross-reference.** Each ADR that depends on another links to
   it ("see ADR-NNN for the per-service hexagonal layout"). Do not
   restate decisions across ADRs — link instead. Walk the entire
   catalogue, not just new entries.

5. **Write `docs/adr/index.md`** — a flat list, one row per ADR:
   number, title, status, date, one-line summary. This file is the
   reading order for any new contributor; place it at
   `docs/adr/index.md` (no number prefix), and link to it from
   `README.md`.

6. **Audit findings cross-link.** ADR-002 lists open audit items
   tracked under `AUDIT-2026-05-08 [CACHE-…]`. If task-11 closed
   any of them, update both `docs/audits/audit-2026-05-08.md` and
   the ADR-002 "Consequences" block to reflect the new status.

## Documentation updates required

- [ ] `README.md`: replace any inline ADR list with a pointer to
  `docs/adr/index.md`.
- [ ] `CLAUDE.md`: add "When making architectural decisions, write
  an ADR. The format is documented in ADR-003 (record architecture
  decisions)."
- [ ] `docs/adr/`: every new ADR added in step 3.

## Verification

- [ ] `yarn install` succeeds.
- [ ] `yarn build` succeeds for all four apps.
- [ ] `yarn lint` succeeds.
- [ ] `yarn test:unit` succeeds.
- [ ] `docs/adr/index.md` lists every ADR with no gaps.
- [ ] No two ADRs share a number.
- [ ] No ADR references a number that doesn't exist
  (`grep -RE 'ADR-?[0-9]+' docs/adr/` to spot-check).
- [ ] Every ADR has Status, Context, Decision, Consequences.

## Carryover

Write `_carryover-13.md` with:
- Existing-ADR audit table (full).
- ADRs added in this task (number + title + decision summary).
- ADR cross-reference adjustments made in step 4.
- Audit-2026-05-08 status changes (if any) flowing back to
  ADR-002.
- Verification results.
- Suggested adjustments to task-14 (cleanup) — particularly any
  ADR that turns out to record a decision the migration ended up
  reversing.
