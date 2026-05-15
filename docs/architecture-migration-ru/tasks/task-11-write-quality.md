# task-11 — Write quality articles (Phase: quality/)

## Context

- Migration source of truth: ADR-017 (architecture lint via
  `eslint-plugin-boundaries`), `eslint.config.mjs` (the rules
  themselves), `tests/lint/architecture-lint.spec.ts` (the
  regression fixture), `CLAUDE.md` "Boundaries rules are
  authoritative" paragraph. Test strategy is covered briefly in
  `_carryover-12.md` and across the migration carryovers.
- Previous carryover:
  `docs/architecture-migration-ru/tasks/_carryover-10.md`
  (READ FIRST).
- Guide root: `docs/architecture-migration-ru/architecture-migration-guide.md`.
- Conventions preamble: see `task-01-survey-and-scaffold.md`.
- Where the guide stands: every architectural concept and stack is
  written. This task covers the **enforcement layer** — how the
  rules actually stay enforced over time (lint + tests).

## Prerequisites

- [ ] `_carryover-10.md` exists and was read first.
- [ ] Build is green on entry.
- [ ] HEAD SHA is recorded in `_carryover-01.md`.

## Goal

Write two articles: one on `eslint-plugin-boundaries` (how the
architectural rules are encoded and enforced), and one on the
project's test strategy (unit, e2e, the lint-regression fixture).

## Article slots to fill

- [ ] `docs/architecture-migration-ru/quality/lib-eslint-plugin-boundaries.md`
- [ ] `docs/architecture-migration-ru/quality/test-strategy.md`

> Approximate guidance:
>
> - **lib-eslint-plugin-boundaries** — ~2500 words. Anchor to
>   ADR-017. The element-type taxonomy (`domain` /
>   `application-use-case` / `application-port` /
>   `application-dto` / `infrastructure` / `presentation` /
>   `app-bootstrap` / `app-shared` / `lib-*`). The unified
>   `boundaries/dependencies` rule with `default: 'disallow'` and
>   `checkAllOrigins: true`. The `capture: ['app', 'module']`
>   template-matched selectors that encode cross-service /
>   cross-module isolation. The documented `ARCH-LINT-EX-01`
>   exception (`EntityManager` leak). What it does NOT do: it does
>   not replace code review, it does not enforce import order
>   (the `tracer.ts`-first-in-`main.ts` rule is still review-only).
> - **test-strategy** — ~2000 words. Jest unit tests (152 across
>   29 suites as of HEAD), the `test/system-api.e2e-spec.ts`
>   end-to-end suite, `yarn test:infra:reload` infra cycle,
>   `yarn test:seed`, `tests/lint/architecture-lint.spec.ts` as the
>   bumper that prevents silent loosening of lint rules. The
>   in-memory port doubles pattern used by use-case specs
>   (e.g. `test-doubles.ts` next to each `application/use-cases/spec/`).

## Steps

1. **Read previous carryover.**
2. **Read the source ADR.** ADR-017 (full).
3. **Read `eslint.config.mjs`.** Cite the `boundariesElements`
   array and the `dependencyRules` array directly. The article
   shows snippets, not the whole file.
4. **Read the architecture-lint regression spec.**
   `tests/lint/architecture-lint.spec.ts`. The article quotes one
   positive case (e.g. domain → lib-ddd allowed) and one negative
   case (e.g. presentation → infrastructure denied) to show what
   the fixture asserts.
5. **Code anchors** (verify in task-01):
   - **lib-eslint-plugin-boundaries**: `eslint.config.mjs` (the
     `boundariesElements`, the `boundaries/dependencies` rule,
     the per-source disallow blocks for `domain`, `application-*`,
     `presentation`, `lib-contracts`, `lib-ddd`).
     `tests/lint/architecture-lint.spec.ts` (the fixture).
     `apps/inventory-microservice/src/modules/stock/application/ports/stock.repository.port.ts`
     (the `ARCH-LINT-EX-01` inline disable + TODO).
   - **test-strategy**: `jest.unit.config.js`, `jest.e2e.config.js`,
     `test/system-api.e2e-spec.ts`, `test/auth.e2e-spec.ts`,
     `test/notification.e2e-spec.ts`,
     `scripts/test-db-seed.ts`,
     `package.json` (the `test:*` scripts).
6. **Cross-link** to `[[module-boundaries]]`,
   `[[hexagonal-architecture]]`,
   `[[shared-libs-philosophy]]`,
   `[[architecture-decision-records]]`.

## Verification

- [ ] Two articles filled, no `заглушка` callouts.
- [ ] Permalinks pinned to the recorded SHA.
- [ ] Every wiki link resolves.
- [ ] No orphans.

## Carryover

Write `_carryover-11.md` per the standard structure.
