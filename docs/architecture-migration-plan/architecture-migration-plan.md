[//]: # (architecture-migration-plan.md)

# Retail Inventory System — Architecture Research & Migration Plan

## TL;DR

- **Recommended pattern:** Adopt **Brocoders Hexagonal Architecture (Ports & Adapters)** as the per-microservice template, applied across the existing NestJS monorepo (`apps/` + `libs/`). Each microservice gets `domain/`, `application/`, `infrastructure/`, `presentation/` layers with TypeORM entities living strictly in `infrastructure/persistence/relational/`. Shared concerns (messaging, observability, auth primitives, base entity, base repository) stay in versioned `libs/*` packages — preserving the user's TypeORM + MySQL + RabbitMQ + Pino stack with no ORM swap.
- **Why not the others:** Awesome Nest Boilerplate is single-app and tightly coupled to a flat `modules/` folder; Squareboat is locked to ObjectionJS (incompatible); Ultimate Backend assumes GraphQL+CQRS+Mongo and would force a rewrite; Domain-Driven Hexagon is the right intellectual reference but uses Slonik (not TypeORM) and is structurally aimed at a single bounded context. Brocoders is the only mature (4.3k★, weekly updates), TypeORM-native, hexagonal template that maps cleanly onto a 4-service Nest monorepo.
- **What to deliver:** Five separate Markdown files (`project-audit.md`, `boilerplate-comparison.md`, `recommendation.md`, `migration-checklist.md`, `sources.md`), each provided in full below — copy each fenced block into a file with the corresponding name. The migration is staged in 6 phases starting from `libs/` (shared kernel) → API Gateway → Retail → Inventory → Notification → cross-cutting (cache-aside, OTel/Jaeger, ADRs).

---

> **Note on the audit (resolved 2026-05-08).** The audit was originally
> reconstructed from a written brief because the fetcher could not access
> the repository in the research session. `task-01-review-project-and-update-plan.md`
> reconciled the audit against the live tree on `RIS-25-Architecture-migration`.
> All `(assumed)` tags have been resolved in `parts/project-audit.md`;
> several claims (JWT/RBAC implemented, single mega-`libs/common`, "fat
> services", Redis unused) were refuted and rewritten. Conventions used
> throughout the plan are recorded in
> `tasks/_carryover-01.md`: `-microservice` suffix kept, path-alias
> prefix `@retail-inventory-system/<name>`, 3-digit ADR padding,
> `libs/auth` built fresh in task-06, no `docs/architecture/` folder.

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

---

## Plan Revisions

A running log of edits to the plan files. Each entry: `<path> — <one-line rationale>`.

### 2026-05-08 (task-01)

- `parts/project-audit.md` — Replaced reconstructed Section 1 stack snapshot, Section 2 directory tree, Section 3 strengths, Section 4 weaknesses, Section 6 planned work with verified facts from the live tree on `RIS-25-Architecture-migration`. All `(assumed)` tags removed; resolved claims marked verified 2026-05-08. JWT/RBAC removed (not implemented); fat-services critique softened (per-action services exist); cache-aside marked done per ADR-002; auth scoped as task-06 future work.
- `parts/recommendation.md` — Adjusted target tree to use `-microservice` suffix on app folders; switched all path aliases to `@retail-inventory-system/<name>`; switched ADR padding to 3-digit; relocated `libs/auth` from Phase 1 to task-06 (built fresh); removed `docs/architecture/` from the target structure; added `libs/config` to the preserved list since the Joi config wrapper stays as-is; added eslint naming-convention preservation note.
- `parts/migration-checklist.md` — Re-scoped each phase to the actual starting state. Phase 1 split into task-03 (foundation) and task-04 (integration) since 4 libs already exist. Phase 3 redefined as "build auth from scratch" (task-06). Phase 4 (notification) now task-07 in the renumbered queue. Phase 7 (cross-cutting) lists the new task numbers. Removed Redis cache-aside line items already covered by ADR-002; added cache generalization for non-stock read paths.
- `architecture-migration-plan.md` — Replaced the "repository inaccessible" caveat with a 2026-05-08 reconciliation note pointing at `tasks/_carryover-01.md`. Added this changelog section.
