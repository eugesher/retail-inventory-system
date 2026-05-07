[//]: # (architecture-migration-plan.md)

# Retail Inventory System — Architecture Research & Migration Plan

## TL;DR

- **Recommended pattern:** Adopt **Brocoders Hexagonal Architecture (Ports & Adapters)** as the per-microservice template, applied across the existing NestJS monorepo (`apps/` + `libs/`). Each microservice gets `domain/`, `application/`, `infrastructure/`, `presentation/` layers with TypeORM entities living strictly in `infrastructure/persistence/relational/`. Shared concerns (messaging, observability, auth primitives, base entity, base repository) stay in versioned `libs/*` packages — preserving the user's TypeORM + MySQL + RabbitMQ + Pino stack with no ORM swap.
- **Why not the others:** Awesome Nest Boilerplate is single-app and tightly coupled to a flat `modules/` folder; Squareboat is locked to ObjectionJS (incompatible); Ultimate Backend assumes GraphQL+CQRS+Mongo and would force a rewrite; Domain-Driven Hexagon is the right intellectual reference but uses Slonik (not TypeORM) and is structurally aimed at a single bounded context. Brocoders is the only mature (4.3k★, weekly updates), TypeORM-native, hexagonal template that maps cleanly onto a 4-service Nest monorepo.
- **What to deliver:** Five separate Markdown files (`project-audit.md`, `boilerplate-comparison.md`, `recommendation.md`, `migration-checklist.md`, `sources.md`), each provided in full below — copy each fenced block into a file with the corresponding name. The migration is staged in 6 phases starting from `libs/` (shared kernel) → API Gateway → Retail → Inventory → Notification → cross-cutting (cache-aside, OTel/Jaeger, ADRs).

---

> **Important note on Phase 1 (audit).** The repository `https://github.com/eugesher/retail-inventory-system` could not be retrieved by the fetcher in this session (the URL was not reachable from the search index, and the raw `nest-cli.json`, `package.json`, and `docker-compose.yml` could not be fetched). The audit below is therefore reconstructed from the user's brief — i.e. it describes the project **as the user described it** (NestJS monorepo, four apps: API Gateway / Retail / Inventory / Notification, TypeORM+MySQL, RabbitMQ, Redis, Docker Compose, GitHub Actions, Pino, JWT+RBAC, with Redis cache-aside, OpenTelemetry/Jaeger, and ADRs planned). Items marked **(assumed)** should be verified by Eugene against the live tree before executing the checklist. The recommendation, comparison, and checklist are not affected — they are stack-driven, not file-content-driven.

---

1. [Project Audit — Retail Inventory System](parts/project-audit.md)
2. [Boilerplate & Pattern Comparison](parts/boilerplate-comparison.md)
3. [Final Recommendation — Hexagonal NestJS Monorepo (TypeORM-native)](parts/recommendation.md)
4. [Migration Checklist — Retail Inventory System → Hexagonal NestJS Monorepo](parts/migration-checklist.md)
5. [Sources Consulted](parts/sources.md)

---

## Caveats

- **Repository inaccessible in this session.** The fetcher could not access
  `https://github.com/eugesher/retail-inventory-system` (likely a permissions
  scope issue with the tool, not necessarily a private repo). The Phase 1
  audit therefore describes the project from the user's written brief; items
  likely-but-unverified are tagged `(assumed)`. Run `tree -L 4 apps libs` and
  diff against the reconstructed tree before executing Phase 1.
- **Star counts and last-commit dates** for boilerplates were captured at
  research time (May 2026) and may have moved since; re-verify before relying
  on "active maintenance" claims for Squareboat (low recent activity), Vivify-
  Ideas, msanvarov, and Ultimate Backend (slowing).
- **CQRS is intentionally deferred.** The recommendation is to _not_ introduce
  `@nestjs/cqrs` on day one. Add it only if a specific use case demands
  separating reads from writes (e.g., a heavy reporting query that warrants a
  dedicated read model). The use-case-class pattern in `application/use-cases/`
  is forward-compatible with later adopting CommandBus/QueryBus.
- **Brocoders is a single-app boilerplate.** Its hexagonal _module_ layout is
  what is being adopted; it is not being cloned wholesale into the monorepo.
- **TypeORM constraint is honored** in the final recommendation. Squareboat
  (ObjectionJS), Sairyss/domain-driven-hexagon (Slonik), mikemajesty/nestjs-
  monorepo (Mongoose), and Ultimate Backend (Mongo) were evaluated for
  _structural_ patterns only and are explicitly marked as ORM-incompatible —
  none of them is the final choice.
- **No existing project files have been changed** by this research session;
  this is the planning/recommendation deliverable only.
