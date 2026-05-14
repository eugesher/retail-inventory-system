# _carryover-13.md — Back-fill structural architecture ADRs (Phase 7, ADRs)

> Generated 2026-05-14 by the task-13 session on branch
> `RIS-37-Architecture-migration-Phase-13-Back-fill-structural-architecture-ADRs`.
> The next task (`task-14`) reads this file as its first action and
> fails fast if it is missing.

## 1. Entry-gate result

`yarn install`, `yarn build` (4 apps), `yarn lint`, `yarn test:unit`
(152 tests across 29 suites) were all green at the start of the
session. Baseline matches `_carryover-12.md`'s reported state.

## 2. Existing-ADR audit

Full table walked at task entry. Status/date/decision summary in the
form a future reader needs to choose what to open.

| #   | Slug                                                        | Status   | Date       | Decision summary                                                                                                  |
| --- | ----------------------------------------------------------- | -------- | ---------- | ----------------------------------------------------------------------------------------------------------------- |
| 001 | `structured-logging-with-pino`                              | Accepted | —          | Pino + `nestjs-pino` for JSON logs; `x-correlation-id` middleware threads a request ID across services.            |
| 002 | `redis-cache-aside-product-stock`                           | Accepted | 2026-05-08 | Cache-aside over Redis for the `SUM/GROUP BY` aggregation; post-commit invalidation; TTL safety net.              |
| 003 | `record-architecture-decisions`                             | Accepted | 2026-05-08 | Codifies Nygard hybrid format, 3-digit padding, and slug rules for the ADR catalogue.                              |
| 004 | `adopt-hexagonal-architecture-per-service`                  | Accepted | 2026-05-09 | Per-module `domain/application/infrastructure/presentation` split for every service.                                |
| 005 | `split-shared-common-into-bounded-libs`                     | Accepted | 2026-05-09 | Carves `libs/{contracts,database,ddd,messaging,cache,observability}` out of the fat `libs/common`.                  |
| 006 | `cache-aside-via-libs-cache`                                | Accepted | 2026-05-10 | Introduces `ICachePort` / `RedisCacheAdapter` / `CACHE_KEYS` while preserving ADR-002's contract.                  |
| 007 | `pino-and-opentelemetry`                                    | Accepted | 2026-05-10 | Co-locates Pino + OTel in `libs/observability`; locks the side-effect tracer-import-first rule in `main.ts`.       |
| 008 | `rabbitmq-via-libs-messaging`                               | Accepted | 2026-05-10 | Centralises RMQ wiring; flips wire-format routing keys to `<service>.<aggregate>.<action>`.                         |
| 009 | `port-adapter-at-the-gateway`                               | Accepted | 2026-05-10 | Reshapes the gateway to per-module hexagonal; `ClientProxy` confined to messaging adapters.                       |
| 010 | `jwt-rbac-at-the-gateway`                                   | Accepted | 2026-05-10 | HS256 JWTs (rotated refresh w/ reuse detection) + argon2id + global `JwtAuthGuard` / `RolesGuard`.                |
| 011 | `notifier-port-and-adapters`                                | Accepted | 2026-05-13 | Builds notification as the canonical per-module template; ports outbound delivery behind `NOTIFIER`.              |
| 012 | `stock-aggregate-and-port-adapter`                          | Accepted | 2026-05-13 | Reshapes inventory to a single `stock` bounded context with repository/cache/events-publisher ports.              |
| 013 | `order-aggregate-and-cross-service-confirm`                 | Accepted | 2026-05-14 | Reshapes retail to a single `orders` bounded context; introduces `INVENTORY_CONFIRM_GATEWAY`.                     |
| 014 | `otel-exporter-otlp-http-and-jaeger`                        | Accepted | 2026-05-14 | OTel SDK with OTLP/HTTP through a collector to Jaeger; `amqplib` hook spans cross-service traces.                  |
| 015 | `pino-trace-correlation`                                    | Accepted | 2026-05-14 | `logMethod` hook enriches every Pino record with the active span's trace/span IDs.                                  |
| 016 | `cache-aside-generalized`                                   | Accepted | 2026-05-14 | `ris:<service>:<aggregate>:<id>` keys; `delByPrefix`; awaited invalidate post-commit; closes 4 audit items.        |
| 017 | `architecture-lint-via-eslint-boundaries`                   | Accepted | 2026-05-14 | Encodes layer + lib boundaries as ESLint rules with a fixture spec; runs inside `yarn lint`.                       |

ADR-001 carries no `**Date**` line because it predates ADR-003's date
convention (introduced 2026-05-08). Both ADR-001 and ADR-002 keep their
historical 3-digit numbering — renumbering to a wider pad would touch
every existing reference for cosmetic gain (called out in ADR-003).

## 3. ADRs added in this task

| #   | Slug                                  | Decision summary                                                                                                                                                                                                                                                                                            |
| --- | ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 018 | `nestjs-monorepo-apps-and-libs`       | Records the NestJS monorepo (single `package.json`, `nest-cli.json` with `monorepo: true`, four `apps/*` services, ten path-aliased `libs/*` libraries) as the baseline every later ADR builds on. Alternatives weighed: polyrepo, Nx workspace, Yarn workspaces with per-lib `package.json`, Bazel.       |
| 019 | `typeorm-and-mysql-for-persistence`   | Records TypeORM + MySQL as the persistence stack: `mysql2` driver, `SnakeNamingStrategy`, hand-written migrations applied through the TypeORM CLI, `BaseEntity` with auto-increment ID. Alternatives weighed: Prisma, MikroORM, ObjectionJS / Knex, raw `mysql2`, PostgreSQL, SQLite-in-dev.                |
| 020 | `rabbitmq-as-inter-service-bus`       | Records RabbitMQ as the transport for both RPC and events; wiring conventions stay in ADR-008. One queue per service; `@nestjs/microservices` with `Transport.RMQ`; broker-aware code confined to adapters by ADR-017. Alternatives weighed: Kafka, NATS/JetStream, Redis Streams, HTTP, gRPC, in-process bus. |

`docs/adr/index.md` is also new — a flat one-row-per-ADR catalogue
linked from `README.md`'s migration-banner paragraph and from
`CLAUDE.md`'s "Architecture rules location" section.

## 4. ADR cross-reference adjustments

Forward references added so the new structural ADRs (018/019/020) are
discoverable from the older ADRs that build on them:

| ADR  | Added references                                                                                                                                                  |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 002  | New `## References` section pointing forward to ADR-006 (port refinement), ADR-016 (generalization), ADR-019 (TypeORM/MySQL), and the audit log.                  |
| 004  | New `## References` section pointing forward to ADR-005, ADR-017, and ADR-018 (the monorepo it lives inside).                                                     |
| 005  | Appended ADR-018 (monorepo) and ADR-019 (database lib's destination) to the existing References section.                                                          |
| 008  | New `## References` section pointing forward to ADR-020 (the broker choice) and back to ADR-004.                                                                  |
| 009  | New `## References` section pointing forward to ADR-004, ADR-008, ADR-018, ADR-020.                                                                               |
| 010  | Appended ADR-019 to the existing References section.                                                                                                              |
| 011  | Appended ADR-020 to the existing References section.                                                                                                              |
| 012  | New `## References` section pointing forward to ADR-002/004/011/016/019/020.                                                                                      |
| 013  | New `## References` section pointing forward to ADR-004/011/012/019/020.                                                                                          |
| 014  | New `## References` section pointing forward to ADR-007, ADR-015, ADR-020.                                                                                        |
| 017  | New `## References` section pointing forward to ADR-004, ADR-005, ADR-018.                                                                                        |

Every edit to a previously-merged ADR was strictly additive (no
restatement of decisions; no edit to existing Status/Context/Decision/
Alternatives/Consequences content). The pattern matches ADR-003's
"one-line pointer" stance, applied uniformly across the catalogue.

ADR-001, ADR-003, ADR-006, ADR-007, ADR-015, ADR-016 were left
untouched — their inline body cross-references already reach the
relevant siblings, and they don't materially benefit from a forward
pointer to 018/019/020.

## 5. Audit-2026-05-08 status changes flowing back to ADR-002

None. `docs/audits/audit-2026-05-08.md` already records task-11's
closures verbatim:

- `CACHE-006` — **resolved** by task-11 / ADR-016 (reach-through now in `libs/cache/redis-cache.adapter.ts`).
- `CACHE-010` — **resolved** by task-11 / ADR-016 (sort comparator via `localeCompare`).
- `CACHE-011` — **resolved** by task-11 / ADR-016 (`__all__` sentinel).
- `CACHE-012` — **superseded** by task-11 / ADR-016 (`invalidateNamedKeys` is gone; non-Redis `delByPrefix` is a no-op).

ADR-002's Consequences block only references `CACHE-001` (race) and
`CACHE-003` (no schema-version segment) — both still open per
ADR-016's "Still open" list — so no edit to the Consequences block
itself was required. The new `## References` block at the end of
ADR-002 (item 4 above) makes the resolution trail navigable for
future readers.

## 6. Documentation updates

- **`README.md`**: the migration-banner paragraph now ends with a
  pointer to `docs/adr/index.md`. The inline ADR references throughout
  the file (`[ADR-NNN](docs/adr/NNN-…)` for specific topics) are
  preserved — they remain the right level of cross-link for topical
  sections. There was never an "inline ADR list" to replace.
- **`CLAUDE.md`**: the "Architecture rules location" paragraph now
  points at `docs/adr/index.md` and bumps the next-free ADR from `018`
  to `021`. A new paragraph immediately below points to ADR-003 for
  the ADR-writing format (matching the task brief: "When making
  architectural decisions, write an ADR. The format is documented in
  ADR-003 (record architecture decisions).").

## 7. Verification results

```
$ yarn install          — Done in 2s 712ms
$ yarn build            — 4 apps compiled successfully
$ yarn lint             — clean (exit 0)
$ yarn test:unit
  Test Suites: 29 passed, 29 total
  Tests:       152 passed, 152 total          (no change from entry gate)
```

Catalogue-integrity gates:

- `ls docs/adr/0*.md` → 001 … 020 (zero gaps, no duplicates).
- `grep -rEo 'ADR-?[0-9]+' docs/adr/ | sort -u` → only 001–020 in use;
  no dangling number.
- Every ADR carries `Status`, `Context`, `Decision`, and `Consequences`
  blocks (one-shot grep confirmed all 20 files satisfy the requirement).
- `docs/adr/index.md` lists every ADR; `README.md` and `CLAUDE.md`
  both point at it.

`yarn test:e2e` was not re-run; nothing in task-13 touches runtime
behaviour. Only docs and ADR files changed.

## 8. Files changed

### Created

| Path                                                              | Role                                                                                                                                                                                                            |
| ----------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `docs/adr/018-nestjs-monorepo-apps-and-libs.md`                   | ADR — records the monorepo as the baseline structure; alternatives weighed (polyrepo, Nx, Yarn workspaces, Bazel); cross-linked from ADR-004/005/009/011/013/017.                                              |
| `docs/adr/019-typeorm-and-mysql-for-persistence.md`               | ADR — records TypeORM + MySQL; alternatives weighed (Prisma, MikroORM, ObjectionJS, raw mysql2, Postgres, SQLite-in-dev); cross-linked from ADR-002/005/010/012/013/016/017.                                  |
| `docs/adr/020-rabbitmq-as-inter-service-bus.md`                   | ADR — records RabbitMQ as the transport for both RPC and events; alternatives weighed (Kafka, NATS, Redis Streams, HTTP, gRPC, in-process); cross-linked from ADR-008/009/011/013/014.                        |
| `docs/adr/index.md`                                               | Flat one-row-per-ADR catalogue (number, title, status, date, one-line summary). Linked from `README.md` and `CLAUDE.md`.                                                                                       |

### Updated (forward references only — no decision text changed)

| Path                                                                                                    | Change                                                                                                                                                  |
| ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `docs/adr/002-redis-cache-aside-product-stock.md`                                                       | Appended `## References` section → ADR-006/016/019 + audit log.                                                                                          |
| `docs/adr/004-adopt-hexagonal-architecture-per-service.md`                                              | Appended `## References` section → ADR-005/017/018.                                                                                                      |
| `docs/adr/005-split-shared-common-into-bounded-libs.md`                                                 | Appended ADR-018 + ADR-019 to the existing References section.                                                                                           |
| `docs/adr/008-rabbitmq-via-libs-messaging.md`                                                           | Appended `## References` section → ADR-020 + ADR-004.                                                                                                    |
| `docs/adr/009-port-adapter-at-the-gateway.md`                                                           | Appended `## References` section → ADR-004/008/018/020.                                                                                                  |
| `docs/adr/010-jwt-rbac-at-the-gateway.md`                                                               | Appended ADR-019 to the existing References list.                                                                                                        |
| `docs/adr/011-notifier-port-and-adapters.md`                                                            | Appended ADR-020 to the existing References list.                                                                                                        |
| `docs/adr/012-stock-aggregate-and-port-adapter.md`                                                      | Appended `## References` section → ADR-002/004/011/016/019/020.                                                                                          |
| `docs/adr/013-order-aggregate-and-cross-service-confirm.md`                                             | Appended `## References` section → ADR-004/011/012/019/020.                                                                                              |
| `docs/adr/014-otel-exporter-otlp-http-and-jaeger.md`                                                    | Appended `## References` section → ADR-007/015/020.                                                                                                      |
| `docs/adr/017-architecture-lint-via-eslint-boundaries.md`                                               | Appended `## References` section → ADR-004/005/018.                                                                                                      |
| `README.md`                                                                                             | Migration-banner paragraph: appended pointer to `docs/adr/index.md`.                                                                                     |
| `CLAUDE.md`                                                                                             | "Architecture rules location" paragraph: pointer to `docs/adr/index.md`; bumped next-free ADR from 018 → 021; appended ADR-003-format note.             |

## 9. Suggested adjustments to task-14 (cleanup)

Task-14 is the shim-removal pass. The ADR catalogue is now complete
and consistent, so task-14 has a clear reference frame for the
clean-up moves. Three concrete carryover items:

1. **No ADR records a reversed decision.** Nothing in 001–020 needs to
   be flipped to `Superseded`. Every shim removal task-14 ships
   completes the path the relevant ADR already declared
   (ADR-005 §"Shim policy for the migration window" explicitly
   schedules the shims for task-14; ADR-016 implicitly retires the
   legacy `stock:*` cache prefix on the first post-deploy write
   afterwards). The Status fields are stable.

2. **`ARCH-LINT-EX-01` (the EntityManager leak on the stock
   repository port) is the only outstanding architectural exception
   from ADR-017 §6.** Closing it lands cleanly in task-14 alongside
   the shim removal. When `ITransactionPort` is introduced, the
   delta is small enough that no new ADR is required — the change is
   a refinement of the abstraction already committed to by ADR-004
   and ADR-012, and the carryover for task-14 can capture the shape
   change.

3. **Cache-key `__all__` sentinel and the legacy `stock:` prefix.**
   ADR-016 says the legacy prefix's invalidation continues for the
   transition window. Task-14 is *not* the right moment to drop it —
   the safer time is one production deploy later (once every running
   replica has been redeployed past the prefix flip). The legacy
   builder is two lines and harmless; carry forward as an open item
   for the post-merge cleanup rather than task-14 scope.

There is no ADR-021 reservation pending; if task-14 makes an
architectural decision (e.g. the `ITransactionPort` shape, the timing
of the legacy-prefix retirement), ADR-021 is its slot.

## 10. Open follow-ups (post-task-13)

1. **`CACHE-001` (cache-aside read/write race) and `CACHE-003` (no
   schema-version segment in keys).** Both remain open in
   `docs/audits/audit-2026-05-08.md`, both still cited by ADR-002's
   Consequences. Neither blocks task-14; a future audit cycle can
   pick them up.
2. **ADR-001 has no `**Date**` line.** Cosmetic — ADR-001 predates
   ADR-003's date convention by one ADR. Backfilling the date would
   be a minor in-place edit; left alone to honor ADR-003's "do not
   edit the old ADR in place" stance and because the catalogue's
   index.md already records the absence (`—` in the Date column).
3. **`libs/ddd` lacks a dedicated ADR.** Task-13 explicitly verified
   ADR-005 covers the lib-split rationale (the brief's wording was
   "verify it covers the rationale for splitting"). `libs/ddd` is
   listed in ADR-005's task-04 rollout, its framework-free constraint
   is encoded in CLAUDE.md and enforced by ADR-017's boundaries
   rules. If a future contributor wants a dedicated ADR for the DDD
   primitives lib, ADR-021 is the slot.
