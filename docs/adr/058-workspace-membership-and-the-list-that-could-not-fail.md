# ADR-058: All six apps become workspace members, and no build file lists them

- **Date**: 2026-09-09
- **Status**: Accepted — the Yarn-pin item under *Open* is **closed**: the `Dockerfile` now reads
  `yarnPath` from `.yarnrc.yml` instead of repeating the release path, so the only declarations
  left are the two `yarn set version` maintains itself

---

## Context

This repository enumerates its own six deployables in four places. Three of those lists were
complete; the fourth had been wrong since the two newest apps were added, and could not say so.

`apps/catalog-microservice/` and `apps/event-store-microservice/` had no `package.json`, so
`yarn workspaces list` returned the root plus **four** apps. `Dockerfile` copied the same four
manifests, one `COPY` line each, before `yarn install --immutable`.

### Three of the four lists report their own gaps; one does not

| Where the apps are listed | If an app is missing |
| --- | --- |
| `nest-cli.json` → `projects` | `nest build <app>` fails at once — the project does not exist |
| root `package.json` → `build:` / `start:dev:` / `start:prod:` scripts | there is no script to run; the omission **is** the symptom |
| `docker-compose.yml` → `services` | the service never starts; `up` is one container short |
| `Dockerfile` → four `COPY apps/<app>/package.json` lines | **nothing happens** |

The last row is the whole defect. A missing manifest copy is inert because the image never needed
it: `.dockerignore` aside, `COPY apps/ apps/` further down brought the sources in wholesale, and
`nest build <app>` reads `nest-cli.json`, not the workspace graph. The list was load-bearing in
exactly one combination — *a workspace member whose manifest was not copied* — and that
combination did not exist, because the two apps the list omitted were not workspace members
either. Two wrongs cancelled, and the arrangement was stable enough to survive four months and
every CI run.

### The defect was inverted: it fired on being fixed, not on being ignored

Adding the two manifests puts two new entries in `yarn.lock`. The image, holding four manifests,
then cannot resolve them. Verified before changing the `Dockerfile` — the old file, the new
manifests, `APP_NAME=catalog-microservice`:

```
YN0028: The lockfile would have been modified by this install, which is explicitly forbidden.
ERROR: process "/bin/sh -c node .yarn/releases/yarn-4.12.0.cjs install --immutable"
       did not complete successfully: exit code: 1
```

So the repository was in a state where *correcting* it broke the build and leaving it alone did
not. That is worth naming, because it inverts the usual review instinct: the person who notices
the asymmetry and adds the missing manifest is the person whose build fails, and the cheapest way
out of that failure is to revert the correction.

### What the four existing manifests contained

Five scripts each — `build`, `start`, `start:dev`, `start:debug`, `start:prod`. None of them work
and none of them are called. `nest` resolves `nest-cli.json` and `tsconfig.json` from the working
directory, and both live at the root:

```
$ cd apps/api-gateway && npx nest build api-gateway
 Error  Could not find TypeScript configuration file "tsconfig.json".
        Please, ensure that you are running this command in the appropriate directory
        (inside Nest workspace).
```

`start:prod` (`node dist/main`) points at a path that does not exist either; the artifact is
`dist/apps/<app>/main.js` at the root. Nothing in `scripts/bash/start-dev.sh`, `ci-cd.yml`,
`docker-compose.yml` or the docs invokes `yarn workspace <app> run …`; `start-dev.sh` drives the
six **root** `start:dev:<app>` scripts through `concurrently`. The scripts are decoration on a
file whose only job is to make Yarn see a directory — with one live effect, which is that an IDE
offers them as run targets and each fails with the message above.

### `libs/*` in the workspaces glob contradicts two accepted ADRs

`workspaces` read `["apps/*", "libs/*"]`, and `libs/*` matched nothing: not one of the nine libs
has a `package.json`. That is not an oversight in `libs/` — it is a decision, recorded twice.
[ADR-005](005-split-shared-common-into-bounded-libs.md) rejected promoting libs to workspaces
(*"no `package.json`, no entry in `yarn workspaces list`"*), and
[ADR-018](018-nestjs-monorepo-apps-and-libs.md) states it as the layout rule (*"Libs are
TypeScript path aliases, not Yarn workspaces"*). The glob asserted the option both ADRs declined.

## Decision

### 1. Six manifests, and they carry nothing but workspace identity

`apps/catalog-microservice/package.json` and `apps/event-store-microservice/package.json` are
added; the `scripts` block is removed from the other four. All six are now:

```json
{
  "name": "<app>",
  "private": true
}
```

There were three options and two of them were bad: copy five proven-broken scripts into two new
files, or leave two manifests unlike the other four — which is the asymmetry this ADR exists to
remove, reintroduced one layer down. The third is to say what the file is for. A workspace
manifest here is a **marker**, not an entry point; the entry points are the root scripts, and
they are the ones that work.

### 2. `workspaces` is `["apps/*"]`

The config now holds ADR-005 and ADR-018's decision instead of contradicting it. Dropping a
`package.json` into a lib no longer silently creates a workspace; if a future ADR reverses that
decision, the glob comes back in the same commit as the ADR that asks for it.

### 3. No build file enumerates the repository's own members unless being wrong has a symptom

The `Dockerfile` copies `apps/` wholesale before the install step, and the later duplicate copy
is removed. The rule this generalizes:

> A hand-written list of the repository's own parts is acceptable **only** where being incomplete
> fails the same command that reads the list. Where an incomplete list is inert — as in an image
> layer that exists to satisfy a resolver — do not write the list. Copy wholesale, or derive it.

And a corollary, because it is the tempting fix: **do not add a checker.** A CI step asserting
"the number of `COPY` lines equals the number of apps" is a second hand-maintained list, with the
same failure mode and one more file to forget.

The three surviving lists in the table above stay exactly as they are. They satisfy the rule: each
is read by a command that fails when the list is short.

## Alternatives Considered

**Leave the two apps out of the workspace.** They built and shipped fine for four months, and this
change buys no feature. Rejected because `yarn workspaces list` is what tooling and newcomers ask
for the set of deployables, and it was answering with two-thirds of it. Whether the wrong answer
has bitten anyone yet is not the test; ADR-046's finding is that the interval before it bites is
unbounded and unowned.

**Keep the per-manifest `COPY` list and add a CI guard.** Rejected — §3's corollary. It also
requires a Docker build in CI, which this project deliberately does not have (`ci-cd.yml` builds
on the host).

**`COPY --parents apps/*/package.json ./`** with `# syntax=docker/dockerfile:1.7-labs`. This
satisfies the rule — it derives the list rather than writing it — and keeps per-manifest cache
granularity. Rejected today because it pins a **labs** Dockerfile frontend that BuildKit pulls
over the network on every build, which is a new failure mode in exchange for cache behaviour that
does not matter here (see Consequences). The alternative is written into the `Dockerfile` as a
comment; switching is two lines, and it is the right switch the day Docker builds enter CI.

**Promote the nine libs to workspaces too**, making the glob honest in the other direction.
Rejected: ADR-005 and ADR-018 both examined it and declined, and nothing about this change is new
evidence. Reversing them needs its own ADR and its own reason.

**Fix the manifest scripts instead of deleting them** — e.g. `"build": "cd ../.. && nest build
<app>"`. Rejected. It duplicates the root scripts with a directory-escaping prefix, giving two
ways to build one app, of which one is a workaround for a directory nobody needed to be in.

## Consequences

### Positive

- `yarn workspaces list` answers correctly. Adding a deployable is one manifest plus the three
  self-reporting lists — no fourth, invisible obligation.
- `docker build` succeeds for all six `APP_NAME` values, including the two that had never been
  workspace members.
- The inverted defect is gone: correcting the repository no longer breaks it, so the next person
  to notice an asymmetry is not punished for saying so.
- Twenty non-functional scripts are gone, and with them an IDE affordance that failed on click.

### Negative / Trade-offs

- **Docker install-layer cache granularity is lost.** Any source change under `apps/` now
  invalidates `yarn install --immutable`. Accepted because Docker builds run from
  `docker-compose` and appear in neither the dev loop (`yarn start:dev`, on the host) nor CI. If
  Docker builds enter CI, take the `--parents` switch above — the trade-off flips there.
- A future lib-as-workspace needs the glob restored. That is the intended cost of §2: the config
  no longer offers an option the ADRs declined, so taking it requires saying so.
- §3's rule is judgment-bearing at its edge: "does being wrong have a symptom?" is answerable per
  list, but not mechanically. The four-row table above is the worked example, not a procedure.

### Open

- **The Yarn version is pinned in three places**: `package.json` → `packageManager`,
  `.yarnrc.yml` → `yarnPath`, and `Dockerfile` → two `node .yarn/releases/yarn-4.12.0.cjs`
  invocations. Same class as this ADR, and it survives it deliberately: the fix is one `sed`
  reading `yarnPath`, but folding it in would make this ADR describe more than its title. Unlike
  the manifest list, a stale copy here fails **loudly** — the file is simply not found — so it is
  a maintenance chore, not a trap. Recorded for its own change.

## References

- [ADR-005](005-split-shared-common-into-bounded-libs.md) — rejected promoting libs to Yarn
  workspaces; §2 makes the config agree with it.
- [ADR-018](018-nestjs-monorepo-apps-and-libs.md) — the `apps/` + `libs/` layout; libs are TS path
  aliases, not workspaces.
- [ADR-046](046-libs-layout-and-dead-export-removal.md) — *a deletion queued behind a condition,
  with no owner and no check, is not queued; it is forgotten.* The manifest list is that shape
  with the condition inverted: not "delete when X", but "wrong until X, and X never came".
- [ADR-048](048-two-scaffold-adapters-that-were-never-wired.md),
  [ADR-049](049-the-port-methods-nothing-calls.md),
  [ADR-050](050-the-alias-that-was-born-deprecated.md) — the dead-code series this continues; the
  twenty removed scripts are ADR-050's shape (an affordance that never worked, kept because
  nobody ran it).
