# ADR-018: NestJS monorepo with `apps/` and `libs/`

- **Date**: 2026-05-14
- **Status**: Accepted

---

## Context

The retail-inventory-system ships four deployable Node services
(`api-gateway`, `retail-microservice`, `inventory-microservice`,
`notification-microservice`) that share cross-service contracts, RabbitMQ
wiring, a TypeORM base, observability glue, and DDD primitives. The repo
was bootstrapped from `@nestjs/cli` with `nest-cli.json`'s `"monorepo":
true` flag — the four services live under `apps/` and the shared code
under `libs/`, both resolved through TypeScript `paths` and the
`@retail-inventory-system/*` aliases.

This structural choice predates the migration but had never been recorded
as an ADR. Every subsequent decision in the catalogue —
[ADR-004](004-adopt-hexagonal-architecture-per-service.md)
(hexagonal-per-service), [ADR-005](005-split-shared-common-into-bounded-libs.md)
(lib split), [ADR-009](009-port-adapter-at-the-gateway.md) (gateway port
split), [ADR-011](011-notifier-port-and-adapters.md) through
[ADR-013](013-order-aggregate-and-cross-service-confirm.md)
(per-service per-module layout), [ADR-017](017-architecture-lint-via-eslint-boundaries.md)
(architecture lint) — assumes the apps-plus-libs layout. Without an ADR
behind it, a future maintainer reading the catalogue cold has no record
of why this is the shape, what alternatives were considered, or what
costs we accepted.

The decision matters because it constrains the build graph
(`nest build <app>` per app), the CI pipeline (one `yarn build` /
`yarn lint` / `yarn test:unit` pass covers all four apps), the dependency
surface (one `package.json` at the root governs every service), and the
release coupling (all four apps ship from a single commit).

---

## Decision

The codebase is a single Git repository organised as a **NestJS
monorepo**:

- One root `package.json`. All runtime and dev dependencies are declared
  once; `yarn` resolves them into a single `node_modules`.
- `nest-cli.json` with `"monorepo": true` and one entry under `projects`
  per deployable service. Each project has its own `tsconfig.app.json`
  and a webpack build that emits to `dist/apps/<service>/`.
- `apps/<service>/` for deployable Node services. Each service has its
  own `main.ts`, its own NestJS `AppModule`, and its own container image
  (built by the per-service Dockerfile + `dist/apps/<service>/main.js`).
- `libs/<name>/` for shared code, imported as
  `@retail-inventory-system/<name>` via `compilerOptions.paths` in
  `tsconfig.json`. Libs are **TypeScript path aliases, not Yarn
  workspaces** — they have no `package.json` of their own. Adding real
  workspaces is reserved for a future ADR if the build graph grows past
  what path aliases comfortably handle.
- Per-app TS configs (`apps/<app>/tsconfig.app.json`) extend the root
  `tsconfig.json` and add an `include` glob for the app's own sources
  plus the libs the app actually consumes.
- A single `yarn lint` / `yarn test:unit` / `yarn build` pass covers the
  whole repo. The `eslint-plugin-boundaries` rules (ADR-017) operate
  over the unified source tree and would not be expressible in a
  polyrepo split.

The monorepo is the **default** for new services. A service is only
extracted to its own repo if it has a credible reason to diverge in
release cadence, dependency stack, or contributor population — none of
which apply today.

---

## Alternatives Considered

**Polyrepo (one Git repository per service).** Rejected. The four
services share enough surface — cross-service DTOs in `libs/contracts`,
the RabbitMQ wire format in `libs/messaging`, the TypeORM base in
`libs/database`, the observability bootstrap in `libs/observability` —
that a polyrepo split would force either (a) a published npm package per
shared lib with version coordination across four repos, or (b) duplicate
copies of every contract drifting silently. The build, lint, and
`@retail-inventory-system/contracts`-anchored type-checking that catch
cross-service drift in a single PR all stop working the moment the
services live in separate repos. The migration's whole shape — one ADR
catalogue, one architecture-lint config, one carryover-driven task queue
— assumes the unified tree.

**Nx workspace.** Rejected. Nx layers a more powerful dependency-graph,
caching, and affected-targets system over a NestJS-style monorepo. It
would speed CI on a repo with dozens of projects and a deep dependency
graph. At four apps and ten libs, the existing `yarn build` finishes in
~10 seconds per app and `yarn lint` in under 30 seconds end-to-end — the
incremental machinery is solving a problem we don't yet have. Adopting
Nx is a low-cost migration if scale demands it; reversing it later is
significantly more expensive. Documented as a future option.

**Yarn / npm workspaces with per-lib `package.json`.** Rejected today.
Workspaces would let each lib declare its own dependency set and version
range, which makes sense when libs are published or when their
dependency graphs genuinely diverge. The libs here all depend on the
same `@nestjs/*` and `typeorm` versions as the apps that consume them;
the per-lib `package.json` would mostly carry empty stubs. The
TS-path-alias approach (status quo) is the smaller commitment and is
trivial to lift into workspaces later without renaming anything.

**Bazel / Pants / similar build systems.** Rejected as
disproportionate. Bazel buys hermetic, cache-friendly builds across
heterogeneous toolchains; this repo is all-TypeScript and webpack
finishes in seconds. The build-system overhead would dwarf the
problem it solves.

---

## Consequences

### Positive

- A cross-service refactor — renaming a routing key, changing a DTO,
  adding a new contract — is **one PR** that touches every consumer.
  TypeScript's compile step is the cross-service drift detector.
- Shared libs are first-class. The `@retail-inventory-system/*` aliases
  give libs the same import ergonomics as a published npm package
  without the publishing cycle.
- CI is a single `yarn install` / `yarn lint` / `yarn build` /
  `yarn test:unit` pass. Architecture lint (ADR-017) treats `apps/*` and
  `libs/*` as one element-type graph; the rules cannot be expressed
  cross-repo without an extra coordination layer.
- New service onboarding is a single `apps/<name>/` folder plus an entry
  in `nest-cli.json`. No new repo to set up CI for, no new dependency
  management.

### Negative / Trade-offs

- All four services ship together. A change to one service requires a
  full repo build/test pass before any service can ship. Acceptable at
  the current scale; if a service later needs an independent release
  cadence, extracting it to its own repo is a focused (but non-trivial)
  project.
- Dependency conflicts surface as repo-wide problems. A library that
  forces `typeorm@0.4.x` on one service forces it on every service. So
  far the shared stack has been a strength, not a constraint.
- The "everything compiles together" property of the monorepo is a
  discipline boundary: a `libs/contracts` change that an app forgets to
  consume creates a stale-DTO bug. Mitigated by the architecture-lint
  rules (ADR-017) that disallow apps from forking their own shadow
  copies of contracts.

---

## References

- `nest-cli.json` — monorepo flag and the four project entries.
- `tsconfig.json` — `compilerOptions.paths` for every
  `@retail-inventory-system/<name>` alias.
- [ADR-004](004-adopt-hexagonal-architecture-per-service.md) — the
  hexagonal layout this ADR's structure hosts.
- [ADR-005](005-split-shared-common-into-bounded-libs.md) — the lib
  split that lives under this ADR's `libs/` umbrella.
- [ADR-017](017-architecture-lint-via-eslint-boundaries.md) — the lint
  rules that treat `apps/*` and `libs/*` as one element-type graph.
