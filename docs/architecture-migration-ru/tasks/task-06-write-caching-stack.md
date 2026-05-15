# task-06 — Write caching stack (Phase: caching/)

> This is a **clarification group**: the stack-overview article must
> explain how the five libraries cooperate, and each per-library
> article zooms into one library's role + what it does NOT do.

## Context

- Migration source of truth: ADR-002 (original cache-aside design),
  ADR-006 (`libs/cache` port + adapter), ADR-016 (generalized
  `ris:<service>:<aggregate>:<id>` keys + `delByPrefix`),
  `parts/recommendation.md` Section 7 (caching libs).
- Previous carryover:
  `docs/architecture-migration-ru/tasks/_carryover-05.md`
  (READ FIRST).
- Guide root: `docs/architecture-migration-ru/architecture-migration-guide.md`.
- Conventions preamble: see `task-01-survey-and-scaffold.md`.
- Where the guide stands: concepts, project shape, persistence, and
  messaging are written. This is the first **clarification-group**
  task — the cache stack confuses readers because four libraries
  (`@nestjs/cache-manager`, `cache-manager`, `keyv`, `@keyv/redis`,
  `cacheable`) all live in the same dependency chain, with
  overlapping roles. The stack-overview article and the five
  per-library articles together must make the cooperation legible.

## Prerequisites

- [ ] `_carryover-05.md` exists and was read first.
- [ ] Build is green on entry.
- [ ] HEAD SHA is recorded in `_carryover-01.md`.
- [ ] Every clarification-group library in this task is confirmed
      present in `package.json` (task-01's `## Discrepancies`
      section is empty for the cache stack).

## Goal

Write a cache-aside pattern article + a cache stack overview + five
per-library articles. After reading the stack overview a reader must
be able to answer:

- Why is there both `cache-manager` and `keyv`?
- What does `@keyv/redis` add on top of `keyv`?
- What does `cacheable` give us that `cache-manager` alone does not?
- What does `@nestjs/cache-manager` wrap, and what does it leave
  alone?

The per-library articles answer the same question one layer deeper —
each one is short (~600–1000 words), terse, and anchored in the
exact code where this project wires it in.

## Article slots to fill

- [ ] `docs/architecture-migration-ru/caching/cache-aside-pattern.md`
- [ ] `docs/architecture-migration-ru/caching/cache-stack-overview.md`
- [ ] `docs/architecture-migration-ru/caching/lib-nestjs-cache-manager.md`
- [ ] `docs/architecture-migration-ru/caching/lib-cache-manager.md`
- [ ] `docs/architecture-migration-ru/caching/lib-keyv.md`
- [ ] `docs/architecture-migration-ru/caching/lib-keyv-redis.md`
- [ ] `docs/architecture-migration-ru/caching/lib-cacheable.md`

> Approximate guidance:
>
> - **cache-aside-pattern** — ~2000 words. Pattern from first
>   principles. Cache-aside vs write-through vs write-behind vs
>   read-through. Diagrams: read flow with hit/miss, invalidation
>   flow with post-commit await. Anchor to ADR-002 + ADR-016.
> - **cache-stack-overview** — ~2500 words. Diagram showing
>   `use case → ICachePort → RedisCacheAdapter → cache-manager →
>   keyv → @keyv/redis → Redis`. Layer-by-layer breakdown of who
>   owns what concern (DI, key dispatch, store interface, transport,
>   wire protocol).
> - **lib-nestjs-cache-manager** — ~700 words. Nest module that
>   adapts `cache-manager` into Nest's DI. What it does NOT do:
>   it doesn't choose a store, doesn't define a key shape, doesn't
>   own the TTL policy.
> - **lib-cache-manager** — ~700 words. The cache façade layer:
>   `get` / `set` / `del` / `wrap`. What it does NOT do: it doesn't
>   speak to Redis, doesn't know how to serialise, doesn't manage
>   connection lifecycle.
> - **lib-keyv** — ~600 words. Storage-adapter abstraction with a
>   single `KeyvStoreAdapter` interface. What it does NOT do: it is
>   not a Redis client, it is the seam where a Redis client plugs
>   in.
> - **lib-keyv-redis** — ~700 words. The actual Redis client
>   underneath `keyv`. What it does (connection pool, SCAN,
>   UNLINK), what it does NOT do (no key namespacing — that's
>   `keyv`'s job).
> - **lib-cacheable** — ~700 words. Multi-tier cache primitive that
>   `RedisCacheAdapter` reaches through to issue `SCAN MATCH ... +
>   UNLINK` for `delByPrefix`. The audit finding `CACHE-006`
>   (the reach-through fragility) lives here.

## Steps

1. **Read previous carryover.**
2. **Read the source ADRs.** ADR-002 (full — original design),
   ADR-006 (port + adapter), ADR-016 (generalized keys + audit
   closures).
3. **Author the pattern article first.** `cache-aside-pattern` is the
   conceptual anchor; the stack overview references it.
4. **Author the stack overview.** Include the layered diagram above.
   Reference every per-library article via `[[wiki-link]]`.
5. **Author each per-library article.** For each, the **"What it does
   NOT do"** section is mandatory and is what makes the article worth
   reading — the cache stack's libraries overlap superficially, and
   the negative space is what disambiguates them.
6. **Code anchors** (verify exact paths in task-01):
   - `libs/cache/cache.module.ts` (the `@Global()` Nest module that
     binds `CACHE_PORT → RedisCacheAdapter`).
   - `libs/cache/cache.port.ts` (the `ICachePort` interface).
   - `libs/cache/redis-cache.adapter.ts` (the only place that reaches
     through `keyv → @keyv/redis` for SCAN+UNLINK).
   - `libs/cache/cache-keys.ts` (`CACHE_KEYS.inventoryStock` and
     `CACHE_KEYS.retailOrder`).
   - `libs/cache/decorators/cacheable.decorator.ts` (`@Cacheable`).
   - `libs/cache/cache-module.config.ts` (the `cacheModuleConfig`
     factory).
   - `apps/inventory-microservice/src/modules/stock/infrastructure/cache/stock.cache.ts`
     — the domain-shaped wrapper that uses `delByPrefix`.
   - `apps/inventory-microservice/src/modules/stock/application/use-cases/reserve-stock-for-order.use-case.ts`
     — the awaited post-commit invalidate.
7. **Document the audit items.** The cache-aside pattern article
   mentions the still-open items (`CACHE-001` race,
   `CACHE-002` post-commit contract, `CACHE-003` no schema-version
   segment, `CACHE-004` no TTL jitter, `CACHE-005` duplicate warn
   logs, `CACHE-009` no tenant segment) from
   `docs/audits/audit-2026-05-08.md` so a reader walking into the
   code is not surprised by the `AUDIT-2026-05-08 [CACHE-*]`
   comments.
8. **Cross-link** to `[[hexagonal-architecture]]` (the port pattern),
   `[[shared-libs-philosophy]]`, `[[message-vs-event-patterns]]`
   (the post-commit invalidate timing tie-in).

## Verification

- [ ] All seven articles filled, no `заглушка` callouts.
- [ ] Permalinks pinned to the recorded SHA on every excerpt.
- [ ] Every wiki link resolves.
- [ ] Each per-library article has a **"Что это НЕ делает"** /
      "What it does NOT do" section.
- [ ] No orphans.

## Carryover

Write `_carryover-06.md` per the standard structure. Be explicit
about which audit items are still open (a reader of the article
should know which `AUDIT-2026-05-08 [CACHE-N]` codes correspond to
live concerns vs codes that ADR-016 closed).
