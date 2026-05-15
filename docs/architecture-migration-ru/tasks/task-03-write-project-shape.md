# task-03 — Write project-shape articles (Phase: project-shape/)

## Context

- Migration source of truth: `docs/architecture-migration-plan/`
  (ADR-018, ADR-009, ADR-005, and `parts/recommendation.md`
  Sections 2 and 7).
- Previous carryover: `docs/architecture-migration-ru/tasks/_carryover-02.md`
  (READ FIRST).
- Guide root: `docs/architecture-migration-ru/architecture-migration-guide.md`.
- Conventions preamble: see `task-01-survey-and-scaffold.md`.
- Where the guide stands: the foundational concepts (hexagonal, DDD,
  layers, module boundaries, ADRs) are written. The vocabulary for
  ports, adapters, aggregates, and layer rules is established. This
  task explains how those concepts are realised at the **project
  shape** level — monorepo, microservices split, gateway pattern,
  shared-libs philosophy.

## Prerequisites

- [ ] `_carryover-02.md` exists and was read first.
- [ ] Build is green on entry.
- [ ] HEAD SHA is recorded in `_carryover-01.md`.
- [ ] Concept articles from task-02 are in `status: review` so this
      task can wiki-link to them safely.

## Goal

Write the four project-shape articles: how the four-service monorepo
is organised, why microservices were chosen, what the API gateway's
job is, and the philosophy behind the `libs/*` split. These are the
"why does the codebase look like this" articles — a reader new to the
repository should walk away knowing where to put a new feature.

## Article slots to fill

- [ ] `docs/architecture-migration-ru/project-shape/nestjs-monorepo.md`
- [ ] `docs/architecture-migration-ru/project-shape/microservices-split.md`
- [ ] `docs/architecture-migration-ru/project-shape/api-gateway-pattern.md`
- [ ] `docs/architecture-migration-ru/project-shape/shared-libs-philosophy.md`

> Approximate guidance per article — task-01 may revise:
>
> - **nestjs-monorepo** — ~1800 words. Anchor to ADR-018. Cover
>   `apps/` vs `libs/`, `nest-cli.json` `monorepo: true`, TS path
>   aliases under `@retail-inventory-system/*`, the
>   one-`package.json` model, the four-app build/lint/test gate. Cite
>   `nest-cli.json`, `tsconfig.json`, `package.json`, and the
>   `dist/apps/<service>/` build output shape.
> - **microservices-split** — ~1800 words. Why four services
>   (gateway + 3 microservices) and not a monolith. Map each service
>   to its bounded context (retail = orders, inventory = stock,
>   notification = outbound delivery, gateway = HTTP edge + auth).
>   Cite ADR-004 (per-service hexagonal) and ADR-020 (RabbitMQ as
>   the seam).
> - **api-gateway-pattern** — ~1800 words. The gateway's two jobs
>   (HTTP edge + cross-service authentication) and what it
>   deliberately is **not** (a business-logic service). Anchor to
>   ADR-009. Cite `apps/api-gateway/src/main.ts` (HTTP bootstrap)
>   and `apps/api-gateway/src/modules/retail/infrastructure/messaging/retail-rabbitmq.adapter.ts`
>   (the only place `ClientProxy` is held).
> - **shared-libs-philosophy** — ~1800 words. The nine-lib split
>   from ADR-005, what each lib is for, what it forbids, and the
>   forbidden-imports rule. Cite `CLAUDE.md`'s "Shared Libraries"
>   table and `eslint.config.mjs`'s `boundariesElements`.

## Steps

1. **Read previous carryover.** Note any glossary terms from task-02
   that this group's articles will reuse — those go into the
   "Глоссарий" sections here as repeated rows so each article is
   self-contained.
2. **Read the source ADRs.** ADR-018, ADR-005, ADR-009, ADR-020.
3. **Author each article** following the skeleton in
   task-01 §11. Suggested code anchors:
   - **nestjs-monorepo**: `nest-cli.json`, `tsconfig.json`
     (`compilerOptions.paths`), `package.json` (`workspaces`),
     `apps/api-gateway/tsconfig.app.json` (verify exact path).
   - **microservices-split**: `apps/*/src/main.ts` files for each of
     the four services — the bootstrap shape is what makes the
     distinction concrete.
   - **api-gateway-pattern**:
     `apps/api-gateway/src/app/app.module.ts` (global guard
     wiring), `apps/api-gateway/src/modules/retail/presentation/order.controller.ts`
     (verify exact path),
     `apps/api-gateway/src/modules/retail/application/ports/retail-gateway.port.ts`.
   - **shared-libs-philosophy**: `libs/contracts/index.ts`,
     `libs/ddd/index.ts`, `libs/cache/index.ts`,
     `eslint.config.mjs` (the `lib-*` element-type definitions),
     `CLAUDE.md` "Forbidden imports" paragraph.
4. **Cross-link** to task-02's concepts.
   `nestjs-monorepo` → `[[module-boundaries]]`,
   `microservices-split` → `[[hexagonal-architecture]]`,
   `api-gateway-pattern` → `[[hexagonal-architecture]]`,
   `shared-libs-philosophy` → `[[module-boundaries]]` and
   `[[architecture-decision-records]]`.
5. **Within-group cross-links** — every article references its three
   peers in "Связанные решения".

## Verification

- [ ] All four slot files filled, no `заглушка` callouts remain.
- [ ] Every code excerpt carries a GitHub permalink pinned to the
      recorded SHA.
- [ ] Every wiki link resolves.
- [ ] No orphans under `docs/architecture-migration-ru/`.
- [ ] Each article ≥ 600 words.

## Carryover

Write `docs/architecture-migration-ru/tasks/_carryover-03.md`:

- `## Articles written` — four paths + summaries.
- `## Glossary terms collected`.
- `## Cross-references added`.
- `## Verification results`.
- `## Suggested adjustments to upcoming tasks`.
