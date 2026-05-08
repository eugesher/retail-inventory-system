# Boilerplate & Pattern Comparison

This document evaluates every NestJS boilerplate and architectural pattern that
showed up across the Awesome NestJS list, the official Nest docs, and reputable
community references, against the criteria stated in the brief. Star counts and
last-commit observations are taken from GitHub at the time of research; treat
them as approximate and re-check before adoption.

## 1. Source URLs reviewed

- https://awesome-nestjs.com/resources/boilerplate.html
- https://github.com/nestjs/awesome-nestjs
- https://github.com/brocoders/nestjs-boilerplate (4.3k ★, very active — weekly Renovate PRs through 2025)
- https://brocoders.github.io/nestjs-boilerplate/architecture.html
- https://github.com/brocoders/nestjs-boilerplate/blob/main/docs/architecture.md
- https://github.com/NarHakobyan/awesome-nest-boilerplate (2.7k ★, active)
- https://narhakobyan.github.io/awesome-nest-boilerplate/docs/architecture.html
- https://github.com/squareboat/nestjs-boilerplate (~700 ★; ObjectionJS — incompatible)
- https://github.com/Tony133/nestjs-api-boilerplate-jwt (~580 ★, NestJS 11 + TypeORM + MySQL)
- https://github.com/vndevteam/nestjs-boilerplate
- https://github.com/Vivify-Ideas/nestjs-boilerplate (TypeORM + MySQL/MariaDB)
- https://github.com/aneudysamparo/NestJS-Boilerplate (MySQL + TypeORM)
- https://github.com/msanvarov/nest-rest-typeorm-boilerplate
- https://github.com/MidoAhmed/nestjs-api-boilerplate
- https://github.com/Sairyss/domain-driven-hexagon (14.4k ★, NestJS+CQRS reference; Slonik, not TypeORM)
- https://github.com/juicycleff/ultimate-backend (CQRS+GraphQL+Mongo SaaS kit)
- https://github.com/mikemajesty/nestjs-monorepo (monorepo + adapter pattern, MongoDB)
- https://github.com/Tarikul01/nest-rabbitmq-microservices (Nx + Nest + RabbitMQ + DLQ)
- https://github.com/maharshi66/nestjs-ecommerce (Nest monorepo + RabbitMQ + TypeORM)
- https://github.com/amroczeK/eda-rabbitmq-nestjs (Nest + RabbitMQ + TypeORM, EDA reference)
- https://github.com/moeedhy/microservices-nestjs-monorepo-boilerplate
- https://github.com/tim-hub/nestjs-hexagonal-example
- https://github.com/eryzerz/nestjs-ddd (Nest + TypeORM + DDD reference)
- https://github.com/kyhsa93/nestjs-rest-cqrs-example (Nest + MySQL + Redis + CQRS + DDD)
- https://docs.nestjs.com/recipes/cqrs (official CQRS module)
- https://github.com/nestjs/cqrs
- https://docs.nestjs.com/microservices/rabbitmq (official RabbitMQ transport)
- https://github.com/MetinSeylan/Nestjs-OpenTelemetry
- https://github.com/nestjs-labs/nestjs-pino-extra (Pino + OTel integration)
- https://signoz.io/blog/opentelemetry-nestjs/
- https://www.tomray.dev/nestjs-open-telemetry
- https://medium.com/@qaribhaider/distributed-tracing-for-nestjs-microservices-with-opentelemetry-and-jaeger-540692c51a55
- https://medium.com/@abdellatif.ellouze/clean-architecture-design-patterns-with-nestjs-9ec5149852b7
- https://medium.com/@lamjed.gaidi070/hexagonal-onion-and-clean-architecture-in-nestjs-c58b526d9f3f
- https://ridakaddir.com/blog/post/nestjs-clean-code-using-hexagonal-architecture
- https://andrea-acampora.github.io/nestjs-ddd-devops/
- https://dev.to/eduardoconti/nestjs-with-rabbitmq-in-a-monorepo-...
- https://dev.to/sairyss/domain-driven-hexagon-18g5

## 2. Comparison matrix (1 = poor, 5 = excellent)

Criteria: **MR** = Monorepo fit, **MS** = Microservices-first, **TO** = TypeORM
compat, **AU** = Auth pattern (JWT+RBAC), **LA** = Layered/clean architecture
clarity, **TS** = Test scaffolding, **OB** = Observability hooks (Pino +
OTel-ready), **MT** = Maturity/professionalism, **AC** = Active maintenance,
**EF** = Migration effort (5 = lowest effort to lift patterns into a 4-service
monorepo).

| Candidate                                        | MR    | MS  | TO                  | AU  | LA    | TS  | OB  | MT  | AC  | EF  | Total  |
| ------------------------------------------------ | ----- | --- | ------------------- | --- | ----- | --- | --- | --- | --- | --- | ------ |
| **Brocoders nestjs-boilerplate**                 | 3     | 2   | **5**               | 5   | **5** | 5   | 4   | 5   | 5   | 4   | **43** |
| **Domain-Driven Hexagon (Sairyss)**              | 3     | 3   | 2                   | 4   | **5** | 5   | 4   | 5   | 4   | 3   | 38     |
| **Awesome Nest Boilerplate (NarHakobyan)**       | 2     | 1   | 5                   | 5   | 3     | 4   | 3   | 5   | 5   | 4   | 37     |
| **mikemajesty/nestjs-monorepo**                  | **5** | 4   | 1                   | 4   | 4     | 4   | 3   | 4   | 3   | 3   | 35     |
| **Tony133 nestjs-api-boilerplate-jwt**           | 2     | 1   | 5                   | 5   | 2     | 3   | 2   | 4   | 5   | 4   | 33     |
| **Vivify-Ideas / aneudysamparo (MySQL+TypeORM)** | 2     | 1   | 5                   | 4   | 2     | 3   | 2   | 3   | 3   | 4   | 29     |
| **kyhsa93/nestjs-rest-cqrs-example**             | 2     | 2   | 4                   | 3   | 5     | 3   | 3   | 4   | 3   | 3   | 32     |
| **maharshi66/nestjs-ecommerce**                  | 5     | 5   | 5                   | 3   | 3     | 2   | 2   | 3   | 2   | 4   | 34     |
| **Tarikul01/nest-rabbitmq-microservices**        | 5     | 5   | 3                   | 3   | 3     | 3   | 3   | 3   | 3   | 3   | 34     |
| **Squareboat nestjs-boilerplate**                | 2     | 1   | **0 (ObjectionJS)** | 4   | 3     | 3   | 2   | 4   | 3   | 1   | 23     |
| **Ultimate Backend (juicycleff)**                | 4     | 5   | 1 (Mongo)           | 4   | 5     | 3   | 3   | 4   | 2   | 1   | 32     |
| **Official @nestjs/cqrs (pattern only)**         | n/a   | 4   | 5                   | 3   | 4     | 4   | 3   | 5   | 5   | 4   | 37     |

> Squareboat is the only candidate scored as a hard incompatibility on TypeORM
> (its data layer is ObjectionJS / Knex). Per the user's constraint, it cannot
> be the final recommendation — but it has been included for completeness in
> case its response transformer / console-command ergonomics are interesting.

## 3. Per-candidate write-ups

### 3.1 Brocoders `nestjs-boilerplate` ⭐ (recommended structural baseline)

- **URL:** https://github.com/brocoders/nestjs-boilerplate
- **Stars / activity:** ~4.3k stars; very active — Renovate-driven dependency
  PRs land weekly and the team merged through 2025.
- **License:** MIT.
- **ORM:** TypeORM (PostgreSQL by default; relational adapter is fully
  swappable, the same pattern works with MySQL).
- **Architecture:** **Hexagonal (Ports & Adapters)**, documented in
  `/docs/architecture.md`. Each module has the exact shape the user needs:

```

domain/
[entity].ts # pure domain object — no decorators
dto/
create.dto.ts
find-all.dto.ts
update.dto.ts
infrastructure/
persistence/
relational/
entities/[entity].ts # TypeORM @Entity
mappers/[entity].mapper.ts
repositories/[entity].repository.ts # ADAPTER
relational-persistence.module.ts
[entity].repository.ts # PORT (interface)
controller.ts
module.ts
service.ts

```

- **Auth:** Email + JWT + refresh tokens, social sign-in, role-based access.
  Maps cleanly onto the user's existing JWT+RBAC.
- **Testing:** Jest unit + e2e + Docker testcontainers in CI.
- **Logging / observability:** Logger configurable; Pino can be plugged in.
- **Docker:** First-class — both relational and document-DB compose files.
- **Microservices?** No — it's a single-app boilerplate. **However**, its
  _per-module_ structure is exactly what each app in a NestJS monorepo should
  look like. That's why it's the recommended **template** rather than a
  drop-in replacement.
- **Why it wins:** Only mature, popular, actively-maintained boilerplate that
  is (a) TypeORM-native, (b) documents hexagonal architecture explicitly, (c)
  has shipped a CLI (`nest g resource`) that scaffolds the layered structure,
  and (d) has working examples of port-vs-adapter separation against TypeORM.

### 3.2 Domain-Driven Hexagon (Sairyss) — the _theoretical_ north star

- **URL:** https://github.com/Sairyss/domain-driven-hexagon
- **Stars:** 14.4k. Excellent reference. Last meaningful commits 2023–2024.
- **ORM:** Slonik (raw SQL). **Incompatible as a drop-in**, but the _patterns_
  (aggregate root, value object, repository port, command/query bus, domain
  event) are TypeORM-agnostic.
- **Architecture:** Full DDD + Hexagonal + CQRS + Onion. Most rigorous
  reference reviewed — but the author explicitly warns that this complexity
  is overkill for simple CRUD.
- **Use it for:** Naming conventions, value-object pattern, base
  `Entity`/`AggregateRoot` classes in `libs/ddd`, repository port shape,
  domain-event base class.
- **Don't copy:** Its database layer.

### 3.3 Awesome Nest Boilerplate (NarHakobyan)

- **URL:** https://github.com/NarHakobyan/awesome-nest-boilerplate
- **Stars:** 2.7k, active. License: MIT.
- **ORM:** TypeORM + Postgres + snake-naming strategy. License: MIT.
- **Auth:** JWT, role decorators, guards.
- **Architecture:** Flat `src/modules/<feature>/{controller,service,entity,dto}`.
  Strong code-style/naming/tests/CI conventions, **but** no domain/application/
  infrastructure separation. Cannot scale to a 4-service monorepo without
  refactoring.
- **Use it for:** ESLint config, snake-naming TypeORM strategy, Polyfill
  `toDto()` pattern, Husky/Commitlint config, schematic generators.

### 3.4 Squareboat `nestjs-boilerplate` — **incompatible (ObjectionJS)**

- **URL:** https://github.com/squareboat/nestjs-boilerplate
- **Stars:** ~700. License: MIT.
- **ORM:** ObjectionJS (Knex). **Hard rule violation** per the user's TypeORM
  constraint. Flagged and **not recommended** as the final choice.
- **Worth borrowing (only as ideas):** custom response transformer pattern,
  native console-commands module, request/response helper conventions.

### 3.5 Tony133 `nestjs-api-boilerplate-jwt`

- **URL:** https://github.com/Tony133/nestjs-api-boilerplate-jwt
- **Stars:** ~580. NestJS 11.x + TypeORM + **MySQL** out of the box (matches
  the user's stack precisely).
- **Architecture:** Flat per-feature folders (`src/<feature>/`). No layered
  separation. Good as a sanity-check that the user's stack is mainstream.
- **Use it for:** TypeORM env-var conventions (`TYPEORM_ENTITIES`,
  `TYPEORM_MIGRATIONS_DIR`), MySQL Docker Compose snippet, JWT strategy
  reference.

### 3.6 mikemajesty `nestjs-monorepo`

- **URL:** https://github.com/mikemajesty/nestjs-monorepo
- **Strengths:** **Best-in-class monorepo layout**: `apps/{auth-api,cats-api}`

* `libs/{core,modules,utils}`. Uses the _adapter pattern_ for ports,
  _anti-corruption layer_, dependency inversion. Has a `monorepo-nestjs-cli`
  scaffolder, Jest unit + e2e, Swagger, Redis, Docker.

- **Weakness:** MongoDB-based (Mongoose). The persistence adapter is wrong for
  the user — but the **library and folder layout is exactly the right shape**.
- **Use it for:** `apps/<svc>/src/modules/<feature>/{adapter,controller,
module,service,repository,schema,entity,swagger,__tests__}` pattern, `libs/`
  split between `core` (framework-free), `modules` (Nest modules), and
  `utils` (helpers).

### 3.7 maharshi66 `nestjs-ecommerce` and Tarikul01 `nest-rabbitmq-microservices`

- **maharshi66:** Nest monorepo + RabbitMQ + TypeORM + Postgres + API gateway +
  order/customer/inventory services + `libs/common`. **Closest existing
  reference** to the user's project.
- **Tarikul01:** Nx-monorepo + Nest + RabbitMQ + Direct/Fanout exchanges + DLQ
  patterns. Excellent reference for **DLQ + reliable messaging**.
- **Use them for:** Inter-service messaging conventions, exchange/topic
  naming, DLQ wiring, gateway-pattern reference.

### 3.8 Ultimate Backend (juicycleff)

- **Strengths:** Multi-tenant SaaS, full CQRS + GraphQL Federation +
  Event-Sourcing.
- **Weaknesses:** GraphQL-first, MongoDB-first, low recent activity.
  Substantially more architecture than this project needs and would force
  abandoning REST + TypeORM. Not recommended.

### 3.9 Official @nestjs/cqrs (pattern, not boilerplate)

- **URL:** https://github.com/nestjs/cqrs · https://docs.nestjs.com/recipes/cqrs
- **Use it for:** Selectively introducing `CommandBus`/`QueryBus`/`EventBus`
  inside `application/` of services that grow complex (likely Retail and
  Inventory). Domain-Driven Hexagon already demonstrates the integration.
- **Don't introduce it everywhere on day one** — start with a plain use-case
  class and only graduate to CQRS when read/write paths actually diverge.

### 3.10 OpenTelemetry / Pino references

- **MetinSeylan/Nestjs-OpenTelemetry:** auto-instrumented Nest layers
  (Guards/Pipes/Controllers).
- **nestjs-labs/nestjs-pino-extra:** Pino + OTel + automatic trace/span ID
  injection — directly solves the user's planned Pino + Jaeger correlation.
- **SigNoz / Tom Ray / Qarib's Medium guide:** all converge on the same
  pattern: start the OTel SDK in a `tracer.ts` _before_ `NestFactory` boots,
  centralize the SDK in `libs/observability`, propagate context across
  RabbitMQ via headers.

## 4. Summary

The TypeORM constraint eliminates Squareboat (ObjectionJS) and demotes
Ultimate Backend, Domain-Driven Hexagon (Slonik), and mikemajesty/nestjs-
monorepo (Mongoose) from "drop-in" status to "borrow patterns from".

The microservice + RabbitMQ + 4-app monorepo constraint eliminates every
**single-app** boilerplate (Brocoders, Awesome-Nest, Tony133, vndevteam,
Vivify-Ideas, MidoAhmed) from "drop-in" status — but their **per-module
internal structure** is still useful.

The intersection is: **adopt Brocoders' hexagonal per-module layout**, stamp
it into each of the four `apps/`, and copy the **monorepo `libs/` layout
philosophy from mikemajesty/maharshi66**. That gives the project (a) a
TypeORM-native layered structure, (b) a multi-service monorepo shape, (c)
clean ports for cache/messaging/observability that future Redis,
OpenTelemetry, and Notification work plugs straight into.
