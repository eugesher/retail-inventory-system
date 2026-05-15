# task-02 — Write foundational concepts (Phase: concepts/)

## Context

- Migration source of truth: `docs/architecture-migration-plan/`
  (particularly `parts/recommendation.md` Sections 1–3 and ADR-004 /
  ADR-005 / ADR-017).
- Previous carryover: `docs/architecture-migration-ru/tasks/_carryover-01.md`
  (READ FIRST). The HEAD SHA section is mandatory; if it is missing
  or malformed, stop and mark **BLOCKED**.
- Guide root: `docs/architecture-migration-ru/architecture-migration-guide.md`
  (already scaffolded by task-01).
- Conventions preamble: see `task-01-survey-and-scaffold.md` — the
  "Conventions for every task in this folder" section. All article
  conventions (frontmatter, skeleton, wiki-links, glossary, callouts)
  apply.
- Where the guide stands: the folder tree and stubs exist; the root
  file has a complete TOC; no concept content has been written yet.
  This task fills the **foundational** layer of the guide — every
  later article assumes these terms have already been defined.

## Prerequisites

- [ ] `_carryover-01.md` exists and was read first.
- [ ] Build is green on entry (`yarn install && yarn build`).
- [ ] HEAD SHA is recorded in `_carryover-01.md` under
      `## HEAD SHA for permalinks`.
- [ ] Every article slot listed below exists as a stub under
      `docs/architecture-migration-ru/concepts/`.

## Goal

Write the five foundational concept articles. These define the
vocabulary every subsequent article assumes — hexagonal, DDD, clean
layers, module boundaries, ADRs. Each article must work as a
**stand-alone tutorial** (mid-level NestJS reader, no prior exposure
to the pattern) and must also tie back to the Retail Inventory System
via concrete code references.

## Article slots to fill

- [ ] `docs/architecture-migration-ru/concepts/hexagonal-architecture.md`
- [ ] `docs/architecture-migration-ru/concepts/domain-driven-design.md`
- [ ] `docs/architecture-migration-ru/concepts/clean-architecture-layers.md`
- [ ] `docs/architecture-migration-ru/concepts/module-boundaries.md`
- [ ] `docs/architecture-migration-ru/concepts/architecture-decision-records.md`

> Approximate guidance per article — task-01 may revise:
>
> - **hexagonal-architecture** — ~2500 words. The longest in the
>   group. Diagrams: the classic hexagon, the port/adapter inversion
>   diagram, and a Retail Inventory System snapshot
>   (`Order` aggregate ↔ `IOrderRepositoryPort` ↔
>   `OrderTypeormRepository`). Anchor to ADR-004.
> - **domain-driven-design** — ~2000 words. Tactical patterns the
>   project actually uses: aggregate, entity, value object, domain
>   event, repository. Do not introduce bounded contexts that the
>   project doesn't have. Anchor to `libs/ddd/` and the `Order` /
>   `StockItem` aggregates.
> - **clean-architecture-layers** — ~1500 words. The four-layer split
>   (`domain` → `application` → `infrastructure` / `presentation`)
>   and the dependency-rule that flows inward. Cite ADR-004 §
>   "Per-module layout" and `recommendation.md` Section 3.
> - **module-boundaries** — ~1500 words. The cross-module and
>   cross-service rules: ports cross modules, contracts cross
>   services, infrastructure never reaches into another module's
>   domain. Anchor to ADR-005 (lib split) and ADR-017 (lint).
> - **architecture-decision-records** — ~1200 words. The Nygard
>   hybrid format, 3-digit padding, when to write one, when not to.
>   Anchor to ADR-003.

## Steps

1. **Read previous carryover.** Open `_carryover-01.md`. Record the
   HEAD SHA. Read `## Inventory` end-to-end so the concept articles
   ground their examples in real code.
2. **Read the source ADRs.** ADR-003, ADR-004, ADR-005, ADR-009,
   ADR-011, ADR-012, ADR-013, ADR-017. The concept articles paraphrase
   these in Russian for an unfamiliar reader; they do not quote the
   ADRs verbatim.
3. **Author each article** following the skeleton in task-01 §11.
   For every code excerpt, build a permalink against the recorded
   SHA. Suggested anchor files (verify each one's exact path in the
   tree before excerpting):
   - **hexagonal**:
     `apps/retail-microservice/src/modules/orders/application/ports/order.repository.port.ts`
     and its adapter
     `apps/retail-microservice/src/modules/orders/infrastructure/persistence/order-typeorm.repository.ts`.
   - **DDD**:
     `apps/retail-microservice/src/modules/orders/domain/order.model.ts`
     (aggregate root),
     `apps/inventory-microservice/src/modules/stock/domain/stock-item.model.ts`
     (aggregate with invariants),
     `libs/ddd/aggregate-root.base.ts` (`pullDomainEvents`).
   - **clean layers**: any `presentation/` controller, any
     `application/use-cases/*.use-case.ts`, the matching port and
     adapter pair.
   - **module boundaries**: `eslint.config.mjs` (the
     `boundariesElements` array), `CLAUDE.md` "Forbidden imports".
   - **ADRs**: `docs/adr/003-record-architecture-decisions.md`
     and `docs/adr/index.md`.
4. **Cross-link** within the group: every article's "Связанные
   решения" section links to at least two of its peers. Each article
   also links forward to one downstream article in another group
   (e.g. `hexagonal-architecture` → `[[mappers-and-repositories]]`).
5. **Add a self-check block** at the end of each concept article — a
   collapsible `> [!faq]` callout with 3–5 questions a reader should
   be able to answer after reading.

## Verification

- [ ] Every article slot listed above is filled (no "заглушка"
      callout remains).
- [ ] Every code excerpt has a GitHub permalink pinned to the SHA
      recorded in `_carryover-01.md`.
- [ ] Every `[[wiki-link]]` resolves to a file that exists.
- [ ] No orphans under `docs/architecture-migration-ru/`.
- [ ] Each article has the mandatory `> [!abstract] Кратко` block at
      the top.
- [ ] Each article has a "Глоссарий" section, even if only one row.
- [ ] Each article exceeds ~600 words (soft floor). Concept articles
      are expected near the high end (~2000 words on average).

## Carryover

Write `docs/architecture-migration-ru/tasks/_carryover-02.md`:

- `## Articles written` — five paths + one-line Russian summaries.
- `## Glossary terms collected` — table of EN→RU pairs introduced.
  These feed the consolidated `glossary.md` in the final task.
- `## Cross-references added` — list of every `[[wiki-link]]` that
  now points out of `concepts/` into another group.
- `## Verification results` — copy of the checklist above with
  ticks.
- `## Suggested adjustments to upcoming tasks` — anything later
  tasks should know (e.g. "the DDD article already covers
  `pullDomainEvents`, so the application-layer article can lean on
  it instead of re-explaining").
