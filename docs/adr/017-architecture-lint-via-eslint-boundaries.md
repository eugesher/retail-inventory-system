# ADR-017: Architecture lint via `eslint-plugin-boundaries`

- **Date**: 2026-05-14
- **Status**: Accepted

---

## Context

By task-11 the codebase had reached its target shape: every service follows the per-module hexagonal layout (`domain` / `application/ports` / `application/use-cases` / `infrastructure` / `presentation`), the shared libs (`@retail-inventory-system/{contracts,ddd,common,database,messaging,cache,observability,auth,config}`) have stable surfaces, and cross-service traffic is RabbitMQ-only.

Until now those rules were enforced **by code review**. `eslint-plugin-boundaries` was installed back in task-02 ([ADR-004](004-adopt-hexagonal-architecture-per-service.md)) but intentionally left off so the migration could proceed without thrashing the lint feedback loop on every checkpoint.

With the layout stable, two risks dominate:

1. **Regression drift.** Future PRs adding a feature can quietly introduce a `Repository<XEntity>` injection into a use case, or import `@nestjs/cache-manager` from outside `libs/cache`, and a reviewer can miss it. The architecture decays one PR at a time.
2. **Onboarding friction.** A new contributor needs the rules; pointing them at a markdown file is weaker than getting a red squiggle in their editor.

Both are addressed by encoding the rules in lint and gating them in CI.

## Decision

### 1. Plugin choice

Adopt `eslint-plugin-boundaries` (v6.0.2, already in `devDependencies`). Rationale:

- Element-type taxonomy maps cleanly onto the hexagonal layout: one element type per layer (`domain`, `application-use-case`, `application-port`, `application-dto`, `infrastructure`, `presentation`, `app-bootstrap`, `app-shared`) plus one per shared lib (`lib-auth`, `lib-cache`, `lib-common`, `lib-config`, `lib-contracts`, `lib-database`, `lib-ddd`, `lib-messaging`, `lib-observability`, `lib-shim`).
- `capture: ['app', 'module']` on the app-layer elements lets us express cross-service and cross-module isolation with a `${from.app}` / `${from.module}` matcher rather than enumerating every (X, Y) pair.
- `dependency.module` selectors cover the per-layer external denylists from the recommendation table (domain forbids `@nestjs/*`, ports forbid `typeorm`, presentation forbids `@keyv/redis`, etc.) — unified with the internal element-to-element rules under a single `boundaries/dependencies` rule.
- The plugin reuses ESLint's standard `import/resolver` setting, so TypeScript path aliases (`@retail-inventory-system/*`) work without extra wiring.

Task-12 uses the v6 API end-to-end: the unified `boundaries/dependencies` rule (with `default: 'disallow'` and `checkAllOrigins: true`), object-based `BaseElementSelectorData` selectors (`{ type: 'X', captured: {...} }`), `{{from.captured.x}}` template syntax, and per-source `dependency: { module: [...] }` policy entries. Index 0 of `dependencyRules` is a single catch-all `allow: { to: { origin: ['external', 'core'] } }` that exempts npm packages and node-core modules from the `default: 'disallow'` polarity; per-source disallow rules later in the array layer specific denylists on top (last match wins).

### 2. Element-type taxonomy

Defined in `eslint.config.mjs` as `boundariesElements`:

| Element type            | Pattern                                              | Capture           |
| ----------------------- | ---------------------------------------------------- | ----------------- |
| `domain`                | `apps/*/src/modules/*/domain/**`                     | `app`, `module`   |
| `application-use-case`  | `apps/*/src/modules/*/application/use-cases/**`      | `app`, `module`   |
| `application-port`      | `apps/*/src/modules/*/application/ports/**`          | `app`, `module`   |
| `application-dto`       | `apps/*/src/modules/*/application/dto/**`            | `app`, `module`   |
| `infrastructure`        | `apps/*/src/modules/*/infrastructure/**`             | `app`, `module`   |
| `presentation`          | `apps/*/src/modules/*/presentation/**`               | `app`, `module`   |
| `app-bootstrap`         | `apps/*/src/main.ts`, `apps/*/src/app/**`            | `app`             |
| `app-shared`            | `apps/*/src/common/**`                               | `app`             |
| `lib-shim`              | `libs/{inventory,retail}/**`, the `libs/common/{cache,config,correlation,modules}/**` subfolders, `libs/config/{cache-module,logger-module}.config.ts` | —                 |
| `lib-{auth,cache,common,config,contracts,database,ddd,messaging,observability}` | `libs/<name>/**`       | —                 |

The shim entry must come before the broad `libs/common/**` entry — the plugin matches the first pattern hit, so narrower patterns inside `libs/common/<subfolder>/**` would otherwise be shadowed.

### 3. Dependency rules (`boundaries/dependencies`, internal edges)

`default: 'disallow'` + `checkAllOrigins: true` — every dependency edge (internal or external) must match an explicit allow rule. The catch-all "allow any external/core target" rule at index 0 keeps npm and node-core modules out of the way; per-source disallow rules later in the array layer specific denylists on top. Highlights of the internal allow rules (full block in `eslint.config.mjs`):

- **`domain`** → own-module `domain`, `lib-ddd`, `lib-common`, `lib-contracts`.
- **`application-use-case`** → own-module `domain`, `application-port`, `application-dto`, `app-shared`, plus `lib-ddd`, `lib-common`, `lib-contracts`, `lib-auth`.
- **`application-port`** → own-module `domain` and `application-port`, plus `lib-ddd`, `lib-contracts`.
- **`application-dto`** → own-module `domain`, plus `lib-contracts`.
- **`infrastructure`** → anything inside its own module + any shared lib (this is where adapters live).
- **`presentation`** → own-module `application-*`, `presentation`, and `app-shared`; plus `lib-auth`, `lib-contracts`, `lib-messaging` (for `ROUTING_KEYS`), `lib-observability` (for `@CorrelationId`).
- **`app-bootstrap`** → anything within its own app + every shared lib.
- **`app-shared`** → own-app `app-shared`, plus `lib-contracts` and `lib-common`.
- **`lib-ddd`** → `lib-ddd` only.
- **`lib-contracts`** → `lib-contracts` only.
- Other libs allow a narrow neighbourhood (`lib-common` may reach `lib-contracts`/`lib-cache`/`lib-config`/`lib-observability`; etc.). The shim element forwards to anything its re-exports need, since shims will disappear in task-14.

Cross-service and cross-module isolation are encoded by the `{{from.captured.app}}` / `{{from.captured.module}}` template-matched `captured` selectors on each `sameModule(...)` / `sameApp(...)` helper output: a `presentation` file in `apps/inventory-microservice/src/modules/stock/` cannot reach a `domain` file in `apps/retail-microservice/src/modules/orders/` because their `app` captures differ.

### 4. External-package rules (`boundaries/dependencies`, `dependency.module` selectors)

Only layers with documented denylists carry external rules. Each entry pins to a `from: { type: 'X' }` source and lists modules under `disallow: { dependency: { module: [...] } }`. Highlights:

- **`domain`** denies `@nestjs/*`, `typeorm`, `@keyv/redis`, `cacheable`, `cache-manager`, `redis`, `amqplib`, `amqp-connection-manager`, `axios`, `nestjs-pino`, `pino`, `pino-http`.
- **`application-use-case`** denies `@keyv/redis`, `cacheable`, `cache-manager`, `redis`, `amqplib`, `amqp-connection-manager`, `@nestjs/cache-manager`, `@nestjs/typeorm`, `typeorm`, `axios`. The transaction seam is the application-layer `ITransactionPort` (`apps/inventory-microservice/src/modules/stock/application/ports/transaction.port.ts`); use cases acquire an opaque `ITransactionScope` from it and pass that scope into repository port methods — they never reach for `EntityManager` directly. Closing the previous `ARCH-LINT-EX-01` exception is what unlocked the tighter denylist; see §6.
- **`application-port`** denies all of `@nestjs/{common,core,microservices,typeorm,cache-manager}`, `typeorm`, `@keyv/redis`, `cacheable`, `cache-manager`, `redis`, `amqplib`, `amqp-connection-manager`, `axios`, `nestjs-pino`.
- **`application-dto`** denies `@nestjs/*`, `typeorm`, `@keyv/redis`, `cacheable`, `redis`, `amqplib`, `axios`.
- **`presentation`** denies `typeorm`, `@keyv/redis`, `cacheable`, `cache-manager`, `redis`, `@nestjs/typeorm`, `amqplib`, `amqp-connection-manager`. Nest controller/swagger/microservices imports stay allowed — that's the entire job of this layer.
- **`lib-contracts`** denies `@nestjs/{common,core,microservices,typeorm,jwt,passport,cache-manager}`, `typeorm`, `@keyv/redis`, `cacheable`, `redis`, `amqplib`. `class-validator`, `class-transformer`, and `@nestjs/swagger` are the documented exceptions: contracts double as the wire-format DTOs that cross HTTP/RPC boundaries, and `@ApiProperty` metadata drives the Scalar OpenAPI viewer wired up in the gateway. The recommendation table read "plain TypeScript only" — task-12 widens that to allow the three decorator packages because the alternative (two parallel DTO trees, one for transport, one for Swagger) buys nothing and doubles the surface to keep in sync.
- **`lib-ddd`** denies `@nestjs/*`, `typeorm`, `@nestjs/typeorm`, `@nestjs/microservices`, `@keyv/redis`, `cacheable`, `cache-manager`, `redis`, `amqplib`.

### 5. CI strategy

The existing `lint` job in `.github/workflows/ci-cd.yml` already runs `yarn lint` as a gating step (`yarn lint --max-warnings 0`). With the boundaries rules wired into `eslint.config.mjs` they execute inside that same step — the option-(a) path the task brief mentioned. No separate `yarn lint:architecture` script and no second workflow file. Rationale: the CI surface stays one job, PR failures still cite the offending rule ID (the boundaries plugin's error messages are precise), and there is no duplicated install/checkout cost.

If clearer per-rule failure messages become valuable later, a sibling script `yarn lint:architecture` that runs ESLint with `--rule '{ "boundaries/*": "error" }'` only is a five-line addition.

### 6. Documented exceptions

No outstanding exceptions.

The previous `ARCH-LINT-EX-01` exception is closed. It covered two files in the stock module that leaked TypeORM's `EntityManager` across the application/infrastructure boundary so the `ReserveStockForOrderUseCase` could compose transactional reads/writes inside a single `transaction(...)` callback:

- `apps/inventory-microservice/src/modules/stock/application/ports/stock.repository.port.ts` — `import { EntityManager } from 'typeorm'` for the transaction-scope arg on port methods.
- `apps/inventory-microservice/src/modules/stock/application/use-cases/reserve-stock-for-order.use-case.ts` — `import { InjectEntityManager } from '@nestjs/typeorm'` to grab the same `EntityManager`.

The fix introduces an `ITransactionPort` abstraction (`apps/inventory-microservice/src/modules/stock/application/ports/transaction.port.ts`) with a `runInTransaction((scope: ITransactionScope) => Promise<T>) => Promise<T>` method and an opaque `ITransactionScope` marker type. Repository port methods now accept `ITransactionScope` instead of `EntityManager`. The downcast back to `EntityManager` lives only in the two infrastructure-layer adapters: `TypeormTransactionAdapter` (`apps/inventory-microservice/src/modules/stock/infrastructure/persistence/typeorm-transaction.adapter.ts`) hands the manager to the work callback under the opaque scope type; `StockTypeormRepository` casts it back when it needs the manager for query construction. With both leaks removed, the `application-use-case` denylist tightens to forbid both `@nestjs/typeorm` and bare `typeorm`, and `application-port` no longer carries an inline ESLint disable.

### 7. Regression test

`tests/lint/architecture-lint.spec.ts` runs ESLint's `Linter` programmatically against hand-crafted fixture source strings, asserting that each rule fires the expected `boundaries/dependencies` ruleId. It covers:

- the per-layer external denylists (domain, use-case, port, presentation, lib-contracts, lib-ddd);
- the per-layer element-type denials (domain ↛ infrastructure, port ↛ infrastructure, presentation ↛ infrastructure, presentation ↛ lib-database);
- the cross-service rule (use-case ↛ another app's domain);
- positive cases (domain → lib-ddd, infrastructure → lib-cache) to guard against an over-broad rule swallowing legitimate edges.

The fixture file paths are virtual — `Linter.verify(code, config, { filename })` accepts a synthetic path and the boundaries plugin matches it against the element patterns the same way it matches real files. The cross-element tests aim their imports at real production files (so the plugin's module resolver can map the import back to an element-typed target).

The spec is added to `apps/**/*.ts` + `libs/**/*.ts` lint scope via the `tests/**/*.ts` relaxation block in `eslint.config.mjs` (same shape as the existing `test/**/*.ts` relaxation), so the strict typing rules don't fire on the fixture source strings.

## Consequences

### Positive

- Architectural drift is caught at PR time, not at the next audit. Reviewers stop being the bottleneck for "is this import OK".
- The rules become discoverable: an editor with the ESLint extension highlights the violation in-line, with the rule ID linking to the plugin's docs.
- The fixture spec gives the rules a unit-test reference frame — if a future change weakens a rule, the spec fails, surfacing the regression before the bad import lands.
- The element-type taxonomy doubles as a vocabulary for code review: "this belongs in `application-port`, not `application-use-case`" is the same thing the lint says.

### Negative

- The lint surface is wider; a contributor adding a feature may have to reshape their imports more often.
- The combined `boundaries/dependencies` rule has more failure modes to reason about than the original split (`boundaries/element-types` + `boundaries/external`): the catch-all "allow any external/core target" rule at index 0 is load-bearing, and accidental over-broad disallow rules can silently block npm imports. The fixture spec is the bumper that catches that class of regression early.

### Open

- An `import-order` rule that enforces `@retail-inventory-system/observability/tracer` as the first import in every `apps/*/src/main.ts` is not part of the boundaries plugin's surface. Today the rule is enforced by code review; a future task can add it via `eslint-plugin-import`'s `import/order` or a small custom rule.
- The shim element type will retire alongside the shim libs in task-14.

## Alternatives considered

- **`eslint-plugin-import` only.** Path-pattern restrictions via `no-restricted-imports` cover the *external* package denylists but cannot express per-layer / per-module isolation without explicitly enumerating every (source, target) tuple — that explodes with each new module. `eslint-plugin-boundaries` is the smallest tool that handles both axes natively.
- **A pre-commit script that greps for forbidden imports.** Faster to write, slower to maintain — every new forbidden pattern is a new grep, and the script can't reason about module resolution (it can't tell `import 'redis'` from `import './redis'`). The boundaries plugin gets module resolution for free via `eslint-import-resolver-typescript`.
- **Split eslint config files** (`eslint.config.mjs` for code style, `eslint.architecture.mjs` for boundaries, two `yarn lint:*` scripts). Rejected: a single config that runs in a single CI step keeps the developer feedback loop shorter and avoids the "I ran one lint but not the other" foot-gun.

---

## References

- [ADR-004](004-adopt-hexagonal-architecture-per-service.md) — the
  layer boundaries this lint encodes.
- [ADR-005](005-split-shared-common-into-bounded-libs.md) — the lib
  taxonomy the element types map onto.
- [ADR-018](018-nestjs-monorepo-apps-and-libs.md) — the unified
  monorepo source tree the boundaries plugin operates over.
