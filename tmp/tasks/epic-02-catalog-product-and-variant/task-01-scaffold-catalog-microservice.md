---
epic: epic-02
task_number: 1
title: Scaffold the new catalog-microservice (monorepo wiring, MessagingModule + DatabaseModule + LoggerModule + tracer-first-import, eslint boundaries)
depends_on: []
doc_deliverable: docs/implementation/02-catalog-product-and-variant/01-new-catalog-microservice-scaffold.md
---

# Task 01 — Scaffold the new `catalog-microservice`

## Required reading

- **Mandatory:** Read `tmp/adr-summary.md` before starting — the index of architectural decisions of record.
- **Recommended:** For any decision relevant to this task, open the linked original ADR under `docs/adr/` before implementing.

## Goal

Stand up an empty, boot-ready fifth Nest application — `apps/catalog-microservice/` — that mirrors the canonical per-module shape of `apps/notification-microservice/` (the cleanest existing reference per ADR-004/009/012/013). After this task the app starts under `yarn start:dev:catalog-microservice`, registers an empty Nest microservice on a new `catalog_queue` RabbitMQ queue, owns its DB connection, emits OTel traces under the service name `catalog-microservice`, and is recognised by ESLint's `eslint-plugin-boundaries` configuration. **No catalog domain code exists yet** — that arrives in task-02.

This task is foundation-only. There are no entity files, no use cases, no controllers, no migrations. Every later task assumes the skeleton put in place here.

## Entry state assumed

Pristine repo at the commit `afdaf02 RIS-43 Batch-01` (or any later commit that has not begun epic-02). Specifically:

- `apps/` contains exactly four applications: `api-gateway`, `inventory-microservice`, `retail-microservice`, `notification-microservice`.
- `libs/contracts/microservices/microservice-queue.enum.ts` defines `INVENTORY_QUEUE`, `RETAIL_QUEUE`, `NOTIFICATION_EVENTS`.
- `libs/contracts/microservices/microservice-client-token.enum.ts` defines `INVENTORY_MICROSERVICE`, `RETAIL_MICROSERVICE`, `NOTIFICATION_MICROSERVICE`.
- `libs/messaging/` contains `microservice-client-{inventory,retail,notification}.module.ts` but **no** catalog module.
- `nest-cli.json` has four entries under `projects`.
- `package.json` defines `start:dev:` and `build:` scripts for the four existing apps.
- `docker-compose.yml` defines services for the four apps + `mysql`, `redis`, `rabbitmq`.
- `infrastructure/otel-collector-config.yaml` lists the four existing OTel `service.name`s for trace routing.
- `eslint.config.mjs` has a boundaries config that captures `apps/*/src/modules/*/{domain,application,infrastructure,presentation}/**`.
- `spec/architecture-lint.spec.ts` exercises that boundary set with fixtures.

## Scope

**In:**

- A new `apps/catalog-microservice/` tree (Nest CLI–generated layout) with the bare bones to boot: `src/main.ts`, `src/app/app.module.ts`, `src/app/index.ts`, `tsconfig.app.json`, `webpack.config.js` (if the other apps have one; otherwise rely on the root webpack.config.js), and a single empty `src/modules/catalog/` placeholder so the module dir exists for task-02 to extend.
- A new `MicroserviceClientCatalogModule` in `libs/messaging/` mirroring `MicroserviceClientNotificationModule`.
- New enum values: `MicroserviceQueueEnum.CATALOG_QUEUE = 'catalog_queue'`, `MicroserviceClientTokenEnum.CATALOG_MICROSERVICE = 'CATALOG_MICROSERVICE'`.
- `nest-cli.json`: add the fifth `projects` entry.
- `package.json`: add `start:dev:catalog-microservice` and `build:catalog-microservice` scripts mirroring the existing four.
- `docker-compose.yml`: add the `catalog-microservice` service (identical shape to `inventory-microservice` — same env vars, same network, same `depends_on`).
- `infrastructure/otel-collector-config.yaml`: add `catalog-microservice` to the routing list.
- `eslint.config.mjs`: register `catalog-microservice` in the `app:` capture set if the rules use an explicit allowlist (they don't appear to today, but verify); otherwise the new tree falls under `apps/*/...` automatically — no change needed. **Crosscheck** by running `yarn lint` against the new tree and confirming no `boundaries/element-types` "unknown element" warnings.
- `spec/architecture-lint.spec.ts`: extend the fixture set so the spec asserts that the new app's tree is governed by the same rules. Concrete extension: a new `describe('catalog-microservice fixtures', ...)` block that mirrors one or two existing fixture blocks for a different app, swapping the path prefix.
- Doc deliverable `01-new-catalog-microservice-scaffold.md`.

**Out:**

- Any domain code (Product/ProductVariant) — task-02.
- Any migration — task-02.
- Routing key constants for `catalog.product.*` — task-03.
- Tracer instrumentation specifics (the shared-library tracer first-import via `@retail-inventory-system/observability/tracer` is part of task-01 because it must run before any Nest import — see ADR-007 §"Side-effect import for OTel bootstrap"; subsequent OTel decisions belong to ADR-014/015, not here).

## Layout to create

Use `apps/notification-microservice/` as the source-of-truth shape (it is the cleanest existing reference). End state after this task:

```
apps/catalog-microservice/
├── tsconfig.app.json
├── src/
│   ├── main.ts
│   ├── app/
│   │   ├── app.module.ts      # imports MessagingModule, DatabaseModule.forRoot([]), LoggerModule, the empty CatalogModule placeholder
│   │   └── index.ts           # re-exports AppModule
│   └── modules/
│       └── catalog/
│           ├── index.ts        # empty barrel for task-02 to fill
│           ├── domain/         # empty dir + .gitkeep
│           ├── application/    # empty dir + .gitkeep
│           ├── infrastructure/
│           │   └── catalog.module.ts   # empty NestJS module — TypeOrmModule.forFeature([]) placeholder
│           └── presentation/   # empty dir + .gitkeep
```

`main.ts` opens with `import '@retail-inventory-system/observability/tracer';` as the very first line (matches the convention used by the four existing microservices — see ADR-007 §"`libs/observability` is the host for both Pino and OTel"; runtime trace routing follows from `OTEL_SERVICE_NAME=catalog-microservice` set in the docker-compose env block, not from any app-local bootstrap file). After the tracer side-effect import, the file bootstraps a `NestFactory.createMicroservice(AppModule, { transport: Transport.RMQ, options: { urls: [process.env.RABBITMQ_URL!], queue: MicroserviceQueueEnum.CATALOG_QUEUE, queueOptions: { durable: true }, noAck: false } })`. Mirror the exact options block from `apps/inventory-microservice/src/main.ts`.

`app.module.ts` imports — in this order, matching the existing apps — `LoggerModule`, `DatabaseModule.forRoot([])` (empty entity list; task-02 adds `ProductEntity` + `ProductVariantEntity`), `MessagingModule`, the empty `CatalogModule` placeholder. The empty `CatalogModule` is intentional — its presence asserts the per-module tree exists so the boundaries config "sees" it; task-02 fills it.

## `libs/messaging/microservice-client-catalog.module.ts`

Mirror `microservice-client-notification.module.ts`. Concretely:

```ts
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ClientsModule } from '@nestjs/microservices';

import {
  MicroserviceClientTokenEnum,
  MicroserviceQueueEnum,
} from '@retail-inventory-system/contracts';

import { MicroserviceClientConfiguration } from './microservice-client.configuration';

@Module({
  imports: [
    ConfigModule,
    ClientsModule.registerAsync([
      new MicroserviceClientConfiguration(
        MicroserviceClientTokenEnum.CATALOG_MICROSERVICE,
        MicroserviceQueueEnum.CATALOG_QUEUE,
      ),
    ]),
  ],
  exports: [ClientsModule],
})
export class MicroserviceClientCatalogModule {}
```

Add the export to `libs/messaging/index.ts`.

## `nest-cli.json` — `projects` entry to add

```json
"catalog-microservice": {
  "type": "application",
  "root": "apps/catalog-microservice",
  "entryFile": "main",
  "sourceRoot": "apps/catalog-microservice/src",
  "compilerOptions": {
    "tsConfigPath": "apps/catalog-microservice/tsconfig.app.json"
  }
}
```

## `package.json` — scripts to add

```json
"build:catalog-microservice": "nest build catalog-microservice",
"start:dev:catalog-microservice": "nest start catalog-microservice --watch",
```

Match the alphabetical positioning of the existing four script families (build/start:dev each as their own block).

## `docker-compose.yml` — service to add

Identical shape to `inventory-microservice`, swapping app name + service name. Env vars:

```yaml
catalog-microservice:
  build:
    context: .
    dockerfile: Dockerfile
    args:
      APP_NAME: catalog-microservice
  container_name: catalog-microservice
  depends_on:
    rabbitmq:
      condition: service_healthy
    mysql:
      condition: service_healthy
    redis:
      condition: service_healthy
  environment:
    NODE_ENV: development
    DATABASE_URL: mysql://retail:retailpass@mysql:3306/retail_db
    REDIS_URL: redis://redis:6379
    RABBITMQ_URL: amqp://guest:guest@rabbitmq:5672
    CACHE_TTL_MS_DEFAULT: 60000
    OTEL_SERVICE_NAME: catalog-microservice
    OTEL_EXPORTER_OTLP_ENDPOINT: http://otel-collector:4318/v1/traces
  volumes:
    - .:/app
    - /app/node_modules
  command: yarn start:dev:catalog-microservice
  networks:
    - backend
```

Note: the catalog-microservice does not expose an external port — it is consumer-only on `catalog_queue`. Matches the inventory/retail/notification shape.

## `infrastructure/otel-collector-config.yaml`

The existing config groups by `service.name` (per ADR-014/015). Add `catalog-microservice` to whatever existing list/processor controls the per-service routing — concrete change depends on the file shape; verify by `grep -n 'inventory-microservice' infrastructure/otel-collector-config.yaml` and applying the same pattern for `catalog-microservice`.

## `eslint.config.mjs` — boundaries

Skim `boundariesElements` (line ~9 onward). The current `pattern: 'apps/*/src/modules/*/...'` already matches the new tree without an allowlist of app names — no edit should be required. To be defensive, run `yarn lint apps/catalog-microservice` after the scaffold lands; if any rule produces an `unknown-element` warning, add the new app to the explicit allowlist in `boundariesElements`. Document the decision (no change vs. explicit allowlist) in the doc deliverable.

## `spec/architecture-lint.spec.ts` — fixture extension

Add a new `describe('catalog-microservice boundaries', ...)` block that runs at least one fixture per element type (domain, application-use-case, application-port, presentation, infrastructure) against synthetic paths under `apps/catalog-microservice/src/modules/catalog/`. Mirror the existing inventory/retail blocks: invent a small TypeScript snippet that violates a rule, assert the expected `boundaries/*` ruleId is reported. The point is regression coverage — task-09 will revisit this if any of the new modules need additional fixtures.

## Files to add

- `apps/catalog-microservice/tsconfig.app.json` (copy from `apps/notification-microservice/tsconfig.app.json` and adjust the `outDir` path).
- `apps/catalog-microservice/src/main.ts`.
- `apps/catalog-microservice/src/app/app.module.ts`.
- `apps/catalog-microservice/src/app/index.ts`.
- `apps/catalog-microservice/src/modules/catalog/index.ts` (empty barrel).
- `apps/catalog-microservice/src/modules/catalog/infrastructure/catalog.module.ts` (empty NestJS module).
- `apps/catalog-microservice/src/modules/catalog/domain/.gitkeep`.
- `apps/catalog-microservice/src/modules/catalog/application/.gitkeep`.
- `apps/catalog-microservice/src/modules/catalog/presentation/.gitkeep`.
- `libs/messaging/microservice-client-catalog.module.ts`.
- `docs/implementation/02-catalog-product-and-variant/01-new-catalog-microservice-scaffold.md`.

## Files to modify

- `libs/contracts/microservices/microservice-queue.enum.ts` — add `CATALOG_QUEUE = 'catalog_queue'`.
- `libs/contracts/microservices/microservice-client-token.enum.ts` — add `CATALOG_MICROSERVICE = 'CATALOG_MICROSERVICE'`.
- `libs/messaging/index.ts` — re-export `MicroserviceClientCatalogModule`.
- `nest-cli.json` — add the fifth projects entry.
- `package.json` — add `start:dev:catalog-microservice` + `build:catalog-microservice` scripts.
- `docker-compose.yml` — add the `catalog-microservice` service block.
- `infrastructure/otel-collector-config.yaml` — add `catalog-microservice` to the OTel service routing.
- `eslint.config.mjs` — only if a defensive allowlist is required; otherwise leave unchanged.
- `spec/architecture-lint.spec.ts` — append the `catalog-microservice` fixture block.

## Files to delete

None.

## Tests

- No domain spec exists yet — the new app has no business logic until task-02.
- The arch-lint spec extension (`spec/architecture-lint.spec.ts`) is the only new test in this task. It must run green under `yarn test:unit`.
- Verify boot manually: `docker compose up -d mysql rabbitmq redis && yarn start:dev:catalog-microservice` should log `Nest microservice successfully started` and `[RabbitMQ] queue=catalog_queue` (or the equivalent log line that the existing microservices emit).

## Doc deliverable

Write `docs/implementation/02-catalog-product-and-variant/01-new-catalog-microservice-scaffold.md`. Target ~150 lines. Sections:

1. **Why a fifth microservice (and not a fifth module inside an existing one).** Cite the report's bounded-context boundary: catalog is the source of truth for `Product`/`ProductVariant` and every downstream cluster keys on `variantId`. Splitting it out keeps catalog reads/writes off the inventory-microservice's hot path and lets the inventory store reduce to its own concerns (stock + movements + reservations).
2. **The per-module shape, recapped.** Reference ADR-004/009/012/013 and the canonical `apps/notification-microservice/src/modules/notifications/` template. The new tree mirrors it line-for-line.
3. **Monorepo wiring summary.** What changed in `nest-cli.json`, `package.json`, `docker-compose.yml`, the OTel collector. Why the same `DATABASE_URL` is reused (single MySQL instance, single schema; the catalog tables live alongside the rest by deliberate choice — split is a Day-2 question).
4. **MessagingModule + the new `catalog_queue`.** The new `MicroserviceClientCatalogModule` mirrors the three existing client modules. The queue name `catalog_queue` lands in `MicroserviceQueueEnum`. Routing keys are deferred to task-03.
5. **Tracer-first-import discipline.** Why `import '@retail-inventory-system/observability/tracer';` is the very first line of `main.ts` ([ADR-007](../../adr/007-pino-and-opentelemetry.md) §"Side-effect import for OTel bootstrap" — the binding ADR for the import-order rule and for the single-host invariant; ADR-014/015 layer on top of that decision but do not redefine it): the OTel SDK must wrap the Node module loader before any Nest import. Failure to honour this silently disables trace correlation. No app-local `otel.setup.ts` is created — every microservice in the repo imports the shared library, and the catalog scaffold follows that convention.
6. **Boundaries lint coverage.** The existing `eslint-plugin-boundaries` configuration already matches the new tree via the `apps/*/...` glob. The arch-lint spec is extended with a new fixture block to assert this guarantee under CI.
7. **What this task did NOT do.** Cross-references to task-02 (domain + persistence + migration), task-03 (write-side use cases + events + routing keys), and task-08 (drop the old inventory `product` table).

## Carryover produced (consumed by task-02 onward)

- The new application boots empty: an empty `CatalogModule` placeholder, no entities registered with `DatabaseModule`, no presentation handlers, no use cases. Task-02 fills these in.
- `MicroserviceQueueEnum.CATALOG_QUEUE` + `MicroserviceClientTokenEnum.CATALOG_MICROSERVICE` are available to task-06 (gateway adapter) and to any future consumer.
- The new `MicroserviceClientCatalogModule` is exported from `libs/messaging/`.
- The monorepo's `start:dev:catalog-microservice` script exists; CI in any future task can rely on it.
- Doc `01-new-catalog-microservice-scaffold.md` exists.

## Exit criteria

- [ ] `yarn lint` passes (`--max-warnings 0`).
- [ ] `yarn test:unit` passes; the new arch-lint fixture block is green.
- [ ] `yarn build:catalog-microservice` produces a `dist/apps/catalog-microservice/main.js` without error.
- [ ] `docker compose up -d mysql rabbitmq redis && yarn start:dev:catalog-microservice` boots the new app; the log line confirms RabbitMQ subscription on `catalog_queue`.
- [ ] `docker compose up -d` brings up all five app containers + dependencies; no container restart-loops.
- [ ] No file outside `tmp/` references `tmp/`.
- [ ] Doc `01-new-catalog-microservice-scaffold.md` exists at the path above and is filled per the section list.
