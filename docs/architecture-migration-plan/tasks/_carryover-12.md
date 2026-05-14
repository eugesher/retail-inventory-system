# _carryover-12.md — Enable architecture lint and CI job (Phase 7, lint)

> Generated 2026-05-14 by the task-12 session on branch
> `RIS-36-Architecture-migration-Phase-12-Enable-architecture-lint-and-CI-job`.
> The next task (`task-13`) reads this file as its first action and
> fails fast if it is missing.

## 1. Entry-gate result

`yarn install`, `yarn build` (4 apps), `yarn lint`, `yarn test:unit`
(138 tests across 28 suites) were all green at the start of the
session. Baseline matches `_carryover-11.md`'s reported state.

## 2. Element-type taxonomy (inline copy)

Defined in `eslint.config.mjs` as `boundariesElements`. Order matters
— the `lib-shim` entry must precede the broad `libs/common/**` /
`libs/config/**` patterns or the narrower shim paths get shadowed.

```ts
const boundariesElements = [
  // App layer elements (per-module hexagonal).
  { type: 'domain',                pattern: 'apps/*/src/modules/*/domain/**',                mode: 'file', capture: ['app','module'] },
  { type: 'application-use-case',  pattern: 'apps/*/src/modules/*/application/use-cases/**', mode: 'file', capture: ['app','module'] },
  { type: 'application-port',      pattern: 'apps/*/src/modules/*/application/ports/**',     mode: 'file', capture: ['app','module'] },
  { type: 'application-dto',       pattern: 'apps/*/src/modules/*/application/dto/**',       mode: 'file', capture: ['app','module'] },
  { type: 'infrastructure',        pattern: 'apps/*/src/modules/*/infrastructure/**',        mode: 'file', capture: ['app','module'] },
  { type: 'presentation',          pattern: 'apps/*/src/modules/*/presentation/**',          mode: 'file', capture: ['app','module'] },
  // App-level bootstrap (composition root). Lives outside any single module.
  { type: 'app-bootstrap',         pattern: ['apps/*/src/main.ts', 'apps/*/src/app/**'],     mode: 'file', capture: ['app'] },
  // App-shared utilities (e.g. apps/*/src/common/**).
  { type: 'app-shared',            pattern: 'apps/*/src/common/**',                          mode: 'file', capture: ['app'] },
  // Shims (removed in task-14) — narrower patterns come first.
  { type: 'lib-shim',              pattern: [
    'libs/inventory/**',
    'libs/retail/**',
    'libs/common/cache/**',
    'libs/common/config/**',
    'libs/common/correlation/**',
    'libs/common/modules/**',
    'libs/config/cache-module.config.ts',
    'libs/config/logger-module.config.ts',
  ], mode: 'file' },
  { type: 'lib-auth',              pattern: 'libs/auth/**',              mode: 'file' },
  { type: 'lib-cache',             pattern: 'libs/cache/**',             mode: 'file' },
  { type: 'lib-common',            pattern: 'libs/common/**',            mode: 'file' },
  { type: 'lib-config',            pattern: 'libs/config/**',            mode: 'file' },
  { type: 'lib-contracts',         pattern: 'libs/contracts/**',         mode: 'file' },
  { type: 'lib-database',          pattern: 'libs/database/**',          mode: 'file' },
  { type: 'lib-ddd',               pattern: 'libs/ddd/**',               mode: 'file' },
  { type: 'lib-messaging',         pattern: 'libs/messaging/**',         mode: 'file' },
  { type: 'lib-observability',     pattern: 'libs/observability/**',     mode: 'file' },
];
```

## 3. Dependency rules (`boundaries/dependencies`, inline copy)

Task-12 uses the unified `boundaries/dependencies` v6 rule. With
`default: 'disallow'` + `checkAllOrigins: true`, every dependency
edge (internal or external) must match an explicit allow rule; the
catch-all `{ from: { type: '*' }, allow: { to: { origin: ['external',
'core'] } } }` at index 0 exempts npm + node-core targets from the
disallow polarity; per-source `dependency.module` disallow rules
later in the array layer specific denylists on top (last match wins).

The `{{from.captured.app}}` / `{{from.captured.module}}` template
matchers encode the per-app and per-module isolation. Trimmed inline
for posterity via two helpers (full block in `eslint.config.mjs`):

```ts
const sameModule = (type) => ({
  to: {
    type,
    captured: {
      app: '{{from.captured.app}}',
      module: '{{from.captured.module}}',
    },
  },
});
const sameApp = (type) => ({
  to: { type, captured: { app: '{{from.captured.app}}' } },
});
const lib = (type) => ({ to: { type } });

const dependencyRules = [
  // 0. Blanket allow for any non-local target.
  { from: { type: '*' }, allow: { to: { origin: ['external', 'core'] } } },

  // Internal allow rules.
  { from: { type: 'domain' }, allow: [
    sameModule('domain'), lib('lib-ddd'), lib('lib-common'), lib('lib-contracts'),
  ]},
  { from: { type: 'application-use-case' }, allow: [
    sameModule('domain'), sameModule('application-port'),
    sameModule('application-dto'), sameModule('application-use-case'),
    sameApp('app-shared'),
    lib('lib-ddd'), lib('lib-common'), lib('lib-contracts'), lib('lib-auth'),
  ]},
  { from: { type: 'application-port' }, allow: [
    sameModule('domain'), sameModule('application-port'),
    lib('lib-ddd'), lib('lib-contracts'),
  ]},
  { from: { type: 'application-dto' }, allow: [
    sameModule('domain'), lib('lib-contracts'),
  ]},
  { from: { type: 'infrastructure' }, allow: [
    sameModule('domain'), sameModule('application-port'),
    sameModule('application-use-case'), sameModule('application-dto'),
    sameModule('infrastructure'), sameModule('presentation'),
    sameApp('app-shared'),
    lib('lib-auth'), lib('lib-cache'), lib('lib-common'), lib('lib-config'),
    lib('lib-contracts'), lib('lib-database'), lib('lib-ddd'),
    lib('lib-messaging'), lib('lib-observability'),
  ]},
  { from: { type: 'presentation' }, allow: [
    sameModule('domain'), sameModule('application-port'),
    sameModule('application-use-case'), sameModule('application-dto'),
    sameModule('presentation'), sameApp('app-shared'),
    lib('lib-auth'), lib('lib-contracts'), lib('lib-messaging'), lib('lib-observability'),
  ]},
  { from: { type: 'app-bootstrap' }, allow: [
    sameApp('domain'), sameApp('application-use-case'),
    sameApp('application-port'), sameApp('application-dto'),
    sameApp('infrastructure'), sameApp('presentation'),
    sameApp('app-shared'), sameApp('app-bootstrap'),
    lib('lib-auth'), lib('lib-cache'), lib('lib-common'), lib('lib-config'),
    lib('lib-contracts'), lib('lib-database'), lib('lib-ddd'),
    lib('lib-messaging'), lib('lib-observability'),
  ]},
  { from: { type: 'app-shared' }, allow: [
    sameApp('app-shared'), lib('lib-contracts'), lib('lib-common'),
  ]},
  // Lib edges — kept narrow.
  { from: { type: 'lib-ddd' },          allow: [lib('lib-ddd')] },
  { from: { type: 'lib-contracts' },    allow: [lib('lib-contracts')] },
  { from: { type: 'lib-common' },       allow: [lib('lib-common'), lib('lib-contracts'), lib('lib-cache'), lib('lib-config'), lib('lib-observability')] },
  { from: { type: 'lib-config' },       allow: [lib('lib-config'), lib('lib-contracts'), lib('lib-cache'), lib('lib-observability'), lib('lib-database')] },
  { from: { type: 'lib-database' },     allow: [lib('lib-database'), lib('lib-common'), lib('lib-contracts')] },
  { from: { type: 'lib-cache' },        allow: [lib('lib-cache'), lib('lib-common'), lib('lib-contracts'), lib('lib-observability')] },
  { from: { type: 'lib-messaging' },    allow: [lib('lib-messaging'), lib('lib-common'), lib('lib-contracts'), lib('lib-observability')] },
  { from: { type: 'lib-observability' },allow: [lib('lib-observability'), lib('lib-common'), lib('lib-contracts')] },
  { from: { type: 'lib-auth' },         allow: [lib('lib-auth'), lib('lib-common'), lib('lib-contracts'), lib('lib-observability')] },
  { from: { type: 'lib-shim' },         allow: [
    lib('lib-auth'), lib('lib-cache'), lib('lib-common'), lib('lib-config'),
    lib('lib-contracts'), lib('lib-database'), lib('lib-ddd'),
    lib('lib-messaging'), lib('lib-observability'),
  ]},

  // External denylists per source layer.
  { from: { type: 'domain' }, disallow: { dependency: { module: [
    '@nestjs/*','typeorm','@keyv/redis','cacheable','cache-manager',
    'redis','amqplib','amqp-connection-manager','axios',
    'nestjs-pino','pino','pino-http',
  ] }}},
  { from: { type: 'application-use-case' }, disallow: { dependency: { module: [
    '@keyv/redis','cacheable','cache-manager','redis',
    'amqplib','amqp-connection-manager',
    '@nestjs/cache-manager','@nestjs/typeorm','axios',
  ] }}},
  { from: { type: 'application-port' }, disallow: { dependency: { module: [
    '@nestjs/common','@nestjs/core','@nestjs/microservices',
    '@nestjs/typeorm','@nestjs/cache-manager',
    '@keyv/redis','cacheable','cache-manager','redis',
    'amqplib','amqp-connection-manager',
    'typeorm','axios','nestjs-pino',
  ] }}},
  { from: { type: 'application-dto' }, disallow: { dependency: { module: [
    '@nestjs/*','typeorm','@keyv/redis','cacheable','redis','amqplib','axios',
  ] }}},
  { from: { type: 'presentation' }, disallow: { dependency: { module: [
    'typeorm','@keyv/redis','cacheable','cache-manager','redis',
    '@nestjs/typeorm','amqplib','amqp-connection-manager',
  ] }}},
  { from: { type: 'lib-contracts' }, disallow: { dependency: { module: [
    '@nestjs/common','@nestjs/core','@nestjs/microservices',
    '@nestjs/typeorm','@nestjs/jwt','@nestjs/passport','@nestjs/cache-manager',
    'typeorm','@keyv/redis','cacheable','redis','amqplib',
  ] }}},
  { from: { type: 'lib-ddd' }, disallow: { dependency: { module: [
    '@nestjs/*','typeorm','@nestjs/typeorm','@nestjs/microservices',
    '@keyv/redis','cacheable','cache-manager','redis','amqplib',
  ] }}},
];
```

`class-validator`, `class-transformer`, and `@nestjs/swagger` are
the documented exceptions for `lib-contracts` (the contracts double
as HTTP/RPC DTOs that drive the Scalar OpenAPI viewer) — they are
NOT listed under the lib-contracts denylist above.

The original v5 split (`boundaries/element-types` +
`boundaries/external`, with array selectors like
`['domain', { app: '${from.app}' }]` and `${...}` templates) is
gone; the v6 form silences the plugin's startup deprecation
warnings. The semantic content is identical to what the task-12
session originally wired and what reviewers signed off on.

## 5. CI integration

`.github/workflows/ci-cd.yml` already runs `yarn lint --max-warnings 0`
as a gating job; the boundaries rules now execute inside that same
step. No second workflow file was added. The job's previous comment
referenced "Task-12 of the architecture migration adds a sibling
`yarn lint:architecture` step" — that proposal was rejected in favour
of the single `yarn lint` gate (option (a) in the task brief). The
comment block in the workflow file is preserved (it documents the
historical intent and future option) but is no longer load-bearing.

A future `yarn lint:architecture` script that runs only the
`boundaries/*` rules is a five-line addition (ESLint's `--rule` flag
plus a config override) if clearer PR failure messages become
valuable.

## 6. Violations encountered and per-file disposition

`yarn lint` reported 12 violations on first run (excluding 2 prettier
nits in the new config file). All were addressed in this task; none
were deferred without a code-level marker.

| # | File                                                                                                            | Disposition                                                                                                                                                                          |
| - | --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1 | `apps/api-gateway/src/modules/inventory/application/use-cases/get-product-stock.use-case.ts`                    | **Fixed.** Use case imported a presentation DTO (`ProductStockGetQueryDto`). Reshaped the signature to take `storageIds: string[] \| undefined` directly; the controller passes `dto.storageIds`. |
| 2 | `apps/inventory-microservice/src/modules/stock/application/ports/stock.repository.port.ts`                      | **Deferred via inline disable + TODO** (`ARCH-LINT-EX-01`). Port methods take `EntityManager` for transaction scoping; a clean fix needs an `ITransactionPort` and is task-14 scope. Suppresses `boundaries/dependencies`. |
| 3 | `apps/inventory-microservice/src/modules/stock/application/use-cases/reserve-stock-for-order.use-case.ts`       | **Deferred via inline disable + TODO** (`ARCH-LINT-EX-01`, same root cause as #2). `InjectEntityManager` from `@nestjs/typeorm`. Suppresses `boundaries/dependencies`.            |
| 4 | `libs/common/config/microservice-client-configuration.ts`                                                       | **Fixed.** Re-tagged via the `lib-shim` element type (broader than `lib-common`); the shim is permitted to forward to any lib it re-exports. Removed in task-14.                  |
| 5 | `libs/common/modules/microservice-client-inventory.module.ts`                                                   | **Fixed.** Same disposition as #4.                                                                                                                                                  |
| 6 | `libs/common/modules/microservice-client-retail.module.ts`                                                      | **Fixed.** Same disposition as #4.                                                                                                                                                  |
| 7 | `libs/contracts/inventory/product-stock/product-stock-get/product-stock-get.response.dto.ts`                    | **Fixed by widening the rule** (ADR-017 §4): `lib-contracts` may import `@nestjs/swagger` (documented exception) because contracts double as the HTTP wire-format DTOs.            |
| 8 | `libs/contracts/retail/dto/order-confirm-response.dto.ts`                                                       | **Fixed by widening the rule** (same as #7).                                                                                                                                        |
| 9 | `libs/contracts/retail/dto/order-create-response.dto.ts`                                                        | **Fixed by widening the rule** (same as #7).                                                                                                                                        |
| 10| `libs/contracts/retail/dto/order-create.dto.ts`                                                                 | **Fixed by widening the rule** (same as #7).                                                                                                                                        |

Two minor prettier formatting errors in `eslint.config.mjs` lines 122
and 294 were auto-fixed by `yarn lint:fix`.

### Deferred exceptions (`--fix-later`)

| Code              | File                                                                                                          | Tracked for |
| ----------------- | ------------------------------------------------------------------------------------------------------------- | ----------- |
| `ARCH-LINT-EX-01` | `apps/inventory-microservice/.../stock/application/ports/stock.repository.port.ts`                            | task-14    |
| `ARCH-LINT-EX-01` | `apps/inventory-microservice/.../stock/application/use-cases/reserve-stock-for-order.use-case.ts`             | task-14    |

The clean fix is an `ITransactionPort` abstraction the use case
acquires from DI and the repository accepts as an opaque token. The
refactor is bigger than task-12's scope and naturally belongs with
the shim cleanup in task-14, when the application layer settles on
its final port surface.

Each suppression carries an `// eslint-disable-line boundaries/dependencies`
plus a TODO comment naming `ARCH-LINT-EX-01`. Re-running `yarn lint`
with the disable removed re-surfaces the violation in seconds — the
suppression is intentional and reversible.

## 7. Lint-fixture regression test

`tests/lint/architecture-lint.spec.ts` (new) runs ESLint's `Linter`
programmatically against hand-crafted fixture source strings,
asserting that each rule fires the expected
`boundaries/element-types` or `boundaries/external` ruleId. The spec
uses synthetic file paths via `Linter.verify(code, config, { filename })`;
cross-element tests point their imports at real production files so
the plugin's module resolver can map the import back to an
element-typed target.

Coverage:

- 7 external-denylist tests (domain, use-case, port, presentation,
  lib-contracts, lib-ddd) — each asserts the expected
  `boundaries/dependencies` ruleId fires.
- 5 element-type-denial tests (domain↛infrastructure,
  port↛infrastructure, presentation↛infrastructure,
  presentation↛lib-database, use-case↛another-app) — also
  `boundaries/dependencies`.
- 2 positive cases (domain → lib-ddd allowed, infrastructure → lib-cache
  allowed) to guard against an over-broad rule swallowing legitimate
  edges.

The spec sits under a new `tests/**/*.ts` relaxation block in
`eslint.config.mjs` (mirror of the existing `test/**/*.ts` block);
the relaxation disables strict typing rules and the `quotes` rule
so fixture source code can use template literals containing single
quotes without escapes.

The spec also pulls `@typescript-eslint/parser` and the boundaries
plugin via `require(...)` rather than ES default-import — under
ts-jest 29 the default-import shape returned `undefined` for these
two CommonJS packages.

## 8. Files changed

### Updated

| Path                                                                                                          | Change                                                                                                                                                                                                                          |
| ------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `eslint.config.mjs`                                                                                           | Wired `eslint-plugin-boundaries`: element-type taxonomy, `element-types` rule, `external` rule, `import/resolver: { typescript }`, ignore block for `tests/lint/fixtures/`, relaxation block for `tests/**/*.ts`.            |
| `apps/api-gateway/src/modules/inventory/application/use-cases/get-product-stock.use-case.ts`                  | Removed the import of `ProductStockGetQueryDto` from presentation; signature now takes `storageIds: string[] \| undefined` directly.                                                                                            |
| `apps/api-gateway/src/modules/inventory/presentation/product.controller.ts`                                   | Passes `dto.storageIds` to the use case.                                                                                                                                                                                       |
| `apps/inventory-microservice/src/modules/stock/application/ports/stock.repository.port.ts`                    | `import { EntityManager } from 'typeorm'` carries a TODO and `// eslint-disable-line boundaries/dependencies` (ARCH-LINT-EX-01).                                                                                              |
| `apps/inventory-microservice/src/modules/stock/application/use-cases/reserve-stock-for-order.use-case.ts`     | `import { InjectEntityManager } from '@nestjs/typeorm'` carries a TODO and `// eslint-disable-line boundaries/dependencies` (ARCH-LINT-EX-01).                                                                                |
| `CLAUDE.md`                                                                                                   | "Forbidden imports" paragraph: added a "Boundaries rules are authoritative" follow-up paragraph; bumped the next-free ADR number from 017 → 018; updated the tracer-first-import bullet to point at task-12's lint surface.   |
| `README.md`                                                                                                   | Added "Architecture lint" sub-section under "Scripts".                                                                                                                                                                         |

### Created

| Path                                                              | Role                                                                                                                                |
| ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `docs/adr/017-architecture-lint-via-eslint-boundaries.md`         | ADR — plugin choice, element-type taxonomy, dependency/external rules, CI strategy, documented exceptions, regression test, alternatives. |
| `tests/lint/architecture-lint.spec.ts`                            | Regression suite — 14 tests asserting every rule fires the expected ruleId on fixture source.                                       |

## 9. Verification results

```
$ yarn install          — Done in 2s 321ms
$ yarn build            — 4 apps compiled successfully
$ yarn lint             — clean (exit 0)
$ yarn test:unit
  Test Suites: 29 passed, 29 total          (net new: +1 suite — tests/lint/architecture-lint.spec.ts)
  Tests:       152 passed, 152 total        (net new: +14 tests — see §7 coverage)
```

`yarn test:e2e` was not re-run; nothing in task-12 touches runtime
behaviour that would invalidate the e2e suite (the only runtime
change is the `get-product-stock.use-case.ts` signature — the HTTP
contract is unchanged because the controller still passes the same
data, and the spec for that use case in
`apps/api-gateway/src/modules/inventory/application/use-cases/spec/`
was implicitly exercised via the rest of the unit suite).

Verification gates:

- `grep -rE 'boundaries/' apps/*/src libs/` → matches only the two
  `eslint-disable-line` annotations in
  `stock.repository.port.ts` and `reserve-stock-for-order.use-case.ts`
  (the documented `ARCH-LINT-EX-01` exceptions). No silent
  suppressions anywhere else.
- `yarn lint` exit 0 with `--max-warnings 0`.
- `tests/lint/architecture-lint.spec.ts` — 14/14 green.

## 10. Audit findings closed by this task

None. Task-12 is a guard-rail task; it doesn't close any of the open
audit findings in `docs/audits/audit-2026-05-08.md`. It does encode
the architectural contract those audits assume so future regressions
get caught in CI rather than the next audit cycle.

## 11. Unexpected findings

1. **`eslint-plugin-boundaries` v6 deprecation noise** (closed
   mid-session). The initial wiring used the v5 rule names
   (`boundaries/element-types`, `boundaries/external`) with
   array-style selectors and `${...}` template syntax — the plugin
   emitted five `[boundaries][warning]: ... deprecated` messages
   per process. Those warnings surfaced inside Jest output too
   (the spec instantiates a new `Linter` per `linter.verify`
   call). Mid-session pivot: did the full v6 migration. New shape
   is one unified `boundaries/dependencies` rule with
   `default: 'disallow'` + `checkAllOrigins: true` and object-based
   selectors (`{ type, captured }`, `{{from.captured.x}}`). The
   load-bearing trick is the catch-all
   `{ from: { type: '*' }, allow: { to: { origin: ['external', 'core'] } } }`
   at index 0 of the rules array — without it, every external
   import would need an explicit allow rule (because `default: 'disallow'`
   applies to all origins when `checkAllOrigins: true`). Per-source
   `dependency.module` disallow rules later in the array layer
   specific denylists on top (last match wins).

2. **`Cacheable.primary.store` dead-path equivalent in boundaries**.
   The plugin's element-pattern matcher picks the **first** matching
   element entry, not the most specific. Putting `lib-common`'s broad
   `libs/common/**` pattern before the narrower
   `libs/common/{cache,config,correlation,modules}/**` shim patterns
   silently re-tagged the shim files as `lib-common`. Symptom: three
   "There is no rule allowing dependencies from lib-common to
   lib-messaging" errors that disappeared the moment `lib-shim` was
   moved to the top of `boundariesElements`. ADR-017 §2 calls this
   out as a config invariant.

3. **`get-product-stock.use-case.ts` was reaching into presentation**.
   The use case took `dto: ProductStockGetQueryDto` directly, a DTO
   that lives under `presentation/dto/`. This is exactly the
   anti-direction `presentation → application` is supposed to
   prevent, but the *other* anti-direction
   (`application → presentation`) was happening because the use case
   adopted the presentation DTO as its own input type. The fix is
   trivial (pass `storageIds: string[] | undefined` instead) and
   illustrates why the lint matters — code review missed this for
   four migration phases.

4. **`@nestjs/swagger` in `libs/contracts/`**. The recommendation
   table read "lib-contracts — plain TypeScript only" but four DTOs
   in `libs/contracts/{retail,inventory}/.../*.dto.ts` import
   `ApiProperty` from `@nestjs/swagger` to drive the Scalar OpenAPI
   viewer at `http://localhost:3000/api/reference`. Two options:
   widen the rule (decision: yes — `@nestjs/swagger` joins
   `class-validator`/`class-transformer` as a documented exception)
   or maintain parallel DTO trees (rejected — doubles the surface
   without buying anything). ADR-017 §4 records the trade-off.

5. **`@typescript-eslint/parser` default-import returns `undefined`
   under ts-jest 29**. Both
   `import boundariesPlugin from 'eslint-plugin-boundaries'` and
   `import * as path from 'path'` returned objects whose `.default`
   was undefined and whose direct shape didn't have the expected
   keys. Switching to `require(...)` in the spec restored the runtime
   shape. The production `eslint.config.mjs` uses native ESM (`.mjs`),
   where default-imports behave correctly — this is a ts-jest CJS
   transform quirk, not an upstream package bug.

## 12. Suggested adjustments to task-13 (ADR back-fill)

Task-13 was originally framed as "back-fill ADRs for decisions made
across the migration". Most of those ADRs landed alongside the
implementing task (002 alongside the cache work, 010 alongside auth,
014/015 alongside observability, 016 alongside the cache
generalization, 017 in this task). The migration plan's recommendation
predates several of those tasks and may also need a small refresh.

Concrete suggestions:

1. **Audit the existing ADR coverage**. Walk
   `docs/architecture-migration-plan/parts/recommendation.md` §1–§7
   and verify each substantial decision has either (a) a published
   ADR or (b) a documented entry in this `CLAUDE.md`. If anything
   is uncovered, write it; if anything is covered twice (recommendation
   text now wrong because an ADR superseded it), update the
   recommendation text in place.
2. **Refresh §3 of the recommendation** to reflect ADR-017's three
   widenings to the strict table:
   - `lib-contracts` may import `class-validator`, `class-transformer`,
     and `@nestjs/swagger` (HTTP/RPC wire-format DTOs).
   - `application-use-case` may import `typeorm` for
     `EntityManager` typings (the `ARCH-LINT-EX-01` deferred
     exception is documented but the table should at least signal
     this is the current state until task-14 lands the
     `ITransactionPort`).
   - `presentation` may import `@retail-inventory-system/messaging`
     for `ROUTING_KEYS` (the `@MessagePattern` decorator's argument).
3. **Add a "Lint as the source of truth" note** to the migration plan
   alongside the recommendation: when text and lint disagree, lint
   wins. The lint can be inspected at `eslint.config.mjs`; the spec
   `tests/lint/architecture-lint.spec.ts` is the regression frame.
4. **No new ADRs likely required** for task-13 itself; the back-fill
   is mostly cross-linking and verification.

## 13. Open follow-ups (post-task-12)

1. **`ARCH-LINT-EX-01`** (the `EntityManager` leak through
   `IStockRepositoryPort` and `ReserveStockForOrderUseCase`)
   should be closed alongside the `libs/common` shim removal in
   task-14, when the application layer settles on its final port
   surface. Introduce `ITransactionPort` (DI-injected) with a `run`
   method that takes a callback; the repository accepts an opaque
   `Transaction` token from the port. Remove the two inline
   `eslint-disable-line` annotations.
2. ~~`boundaries/external` and `boundaries/element-types` →
   `boundaries/dependencies` (v6)~~ — **done in task-12**. The
   unified rule, object-based selectors, and `{{from.captured.x}}`
   templates are all live. The plugin emits no deprecation
   warnings under the current config.
3. **Import-order rule for `main.ts`** — enforce that
   `@retail-inventory-system/observability/tracer` is the first import
   in every `apps/*/src/main.ts`. The boundaries plugin doesn't
   model ordering; `eslint-plugin-import`'s `import/order` with a
   custom rule, or a tiny hand-rolled rule, would close the gap.
4. **`yarn lint:architecture` shortcut** — five-line script that runs
   ESLint with just the `boundaries/*` rules enabled, for clearer
   PR failure messages when only the architecture rules fail. Not
   needed today (the existing `yarn lint` cites the rule IDs
   precisely), but trivial to add when desirable.
5. **Lint-fixture coverage gaps** — the spec covers the central
   denials but not every cell of the matrix. A future expansion
   could add tests for each lib-to-lib edge (e.g. `lib-common ↛
   lib-messaging`) and each per-layer external denial individually.
   Diminishing returns past ~20 tests; current coverage is enough
   to catch the broad classes of regression.
