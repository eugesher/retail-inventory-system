# ADR-061: One Dockerfile for six deployables, parameterized by `APP_NAME`

- **Date**: 2026-09-10
- **Status**: Accepted

---

## Context

This repository builds six container images from **one** `Dockerfile` at the root, selected by
`ARG APP_NAME`. `docker-compose.yml` names it six times with six different values. That has been
true since `d8e6bf9` (**2026-04-03**, RIS-23 *Project Audit*), which deleted the four per-service
`apps/*/Dockerfile` files that `ccbeac9` had shipped in February and replaced them with the
parameterized one.

**No ADR recorded it.** And the omission has been invisible for five months for a specific reason:
the one place in the repository that mentions container images describes the arrangement RIS-23
replaced. [ADR-018](018-nestjs-monorepo-apps-and-libs.md), written **six weeks later**, says:

> *`apps/<service>/` for deployable Node services. Each service has its own `main.ts`, its own
> NestJS `AppModule`, and its own container image (built by the **per-service Dockerfile** +
> `dist/apps/<service>/main.js`).*

Neither `README.md` nor `CLAUDE.md` contains the word `Dockerfile`. So the entire documented
container strategy is that one clause, and it is wrong.

That combination is worth naming, because it is not the same defect as an undocumented decision.
**An undocumented decision leaves a gap someone can notice. A stale sentence standing where the
record should be fills the gap, and is read as the record.** The place looked documented, so
nobody wrote the ADR — including the five months in which the `Dockerfile` was edited twice
([ADR-058](058-workspace-membership-and-the-list-that-could-not-fail.md), and the Yarn-path
derivation that closed its `Open` item).

## Decision

### 1. One `Dockerfile`, parameterized by `APP_NAME`

Recorded as it stands, so that the next reader has something to disagree with:

- `ARG APP_NAME`, required — `RUN test -n "$APP_NAME" || (echo … && exit 1)` fails the build
  immediately rather than producing an image for nothing.
- The builder stage installs the **whole workspace** once (`yarn install --immutable`) and runs
  `build:${APP_NAME}`; the runtime stage copies `node_modules` and `dist/apps/${APP_NAME}/`.
- `docker-compose.yml` carries the six values; nothing else selects an app.

Adding a deployable therefore touches four hand-maintained lists — `nest-cli.json` `projects`, the
three root scripts, a workspace manifest, a compose service — **and no build file**. Three of those
four fail loudly when incomplete; that is the test ADR-058 §3 sets, and this arrangement passes it.

### 2. Why one and not six

The forty lines are identical per app modulo the name: same base image, same manifest copy, same
install, same `build:<app>`, same `CMD`. Six copies of that are exactly the hand-maintained list
ADR-058 §3 warns about — and here **being wrong has no symptom**, because each copy is exercised
only by its own compose service. A fifth Dockerfile that had drifted would still build a working
image; it would simply build it differently, and nothing compares them.

The claim is not theoretical. Two changes landed in this file since ADR-058 — the workspace-manifest
copy and the Yarn-path derivation — and each was one edit. Under six Dockerfiles each would have
been six, with the fifth and sixth being the ones nobody remembers.

### 3. ADR-018's container clause is superseded

[ADR-003](003-record-architecture-decisions.md) allows an accepted ADR to be edited only by
flipping `Status` and adding a one-line pointer, so ADR-018's text is untouched and its `Status`
now points here.

## Alternatives Considered

**Six per-service Dockerfiles** — the arrangement RIS-23 replaced. It buys per-app tuning nothing
in this system asks for (every service is the same Node runtime running the same shape of bundle)
and costs six silent copies. Rejected on §2.

**A shared base image plus six thin Dockerfiles.** Build `ris-deps` once with the installed
workspace, then six images that only `COPY --from=ris-deps` and add their bundle. This is genuinely
better on image size and on total build time across six images, and it is the natural next step if
the numbers below start to hurt. Not taken now because it introduces a second artifact that must be
built, versioned and published in step with the lockfile — a base image is itself a copy of a fact,
and one that goes stale silently.

**One Dockerfile with six named build stages, selected by `--target`.** No gain: the stages would
be identical apart from the app name, which is what `ARG` already expresses, and `docker-compose`
would carry six target names instead of six `APP_NAME` values.

## Consequences

### Positive

- One file. A change to the build lands once, and cannot land in four of six places.
- No new build file per deployable; the lists that do grow are the ones whose incompleteness fails
  a command.

### Negative / Trade-offs — measured, not estimated

Every image carries the **whole monorepo's** `node_modules`. On the `api-gateway` image built from
this file today:

| | |
| --- | --- |
| image | **882 MB** |
| `/app/node_modules` | **541.7 MB** |
| `/app/dist` | **1.0 MB** |

The bundle genuinely needs runtime dependencies — `webpack.config.js` uses `webpack-node-externals`
with only `@retail-inventory-system/*` allowlisted, so npm packages are `require`d at runtime rather
than inlined — but the tree that ships is the **dev** install: `@types` 70 MB, `@angular-devkit`
25 MB, `typescript` 23 MB, `@jest` 16 MB.

This cost is **not** caused by parameterization; six Dockerfiles copying the same builder tree would
each carry the same 542 MB. It is recorded here because this file no longer has anywhere else to be
described.

Cache granularity is the other cost, and it is ADR-058's, not this ADR's: `COPY apps/ apps/` before
the install means any source change under `apps/` invalidates the install layer. Accepted there on
the grounds that Docker builds run from compose and appear in neither the dev loop nor CI.

### Open

- **The runtime stage ships dev dependencies.** Roughly 135 MB of the 542 MB is tooling that cannot
  be reached at runtime. Yarn 4 has no `install --production`; the mechanism would be
  `yarn workspaces focus --production` in a third stage — which needs the `workspace-tools` plugin,
  and `.yarn/plugins/` is currently empty — or pruning the copied tree. Left for its own change
  because it needs evidence that nothing at runtime resolves a dev dependency, and the OpenTelemetry
  auto-instrumentation packages make that non-obvious to establish by reading.

## References

- [ADR-018](018-nestjs-monorepo-apps-and-libs.md) — the `apps/` + `libs/` layout; its per-service
  container clause is superseded here.
- [ADR-058](058-workspace-membership-and-the-list-that-could-not-fail.md) — *a hand-written list of
  the repository's own parts is acceptable only where being incomplete fails the same command that
  reads it*; §2 above applies that test to Dockerfiles, and §Consequences inherits its cache
  trade-off.
