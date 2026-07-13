# ADR-046: The `libs/` layout, and three exports nothing imports

- **Date**: 2026-07-12
- **Status**: Accepted

---

## Context

A pass over `libs/` — nine libraries — for layout consistency turned up two things. The layout was the question asked. The dead exports were the thing worth finding.

### Two conventions, and one of them applied where it shouldn't be

| | libraries |
| --- | --- |
| **Grouped** into subfolders | `contracts` (8), `common` (5), `cache` (`decorators/`) |
| **Flat, and rightly so** | `database` (5 files), `ddd` (6), `config` (1) |
| **Flat, with an obvious family inside** | `messaging` (12 root files — **7** of them `microservice-client-*`), `auth` (12 — 3 guards + 4 decorators), `observability` (8 — 4 correlation files) |

The third row is the problem. `libs/messaging`'s flat list reads as a dozen unrelated things, when more than half of it is one family.

### Three exports with no consumer — and a comment saying otherwise

| Export | What its comment claims | What the code does |
| --- | --- | --- |
| `RabbitmqClientFactory` | *"Used by callers that want a one-off proxy … (tests, bootstrap scripts)"* | **zero** callers — including in `test/` and `scripts/` |
| `MetricsModule` | *"Empty today **so app modules can already declare the import**"* | **zero** app modules import it |
| `TraceContextInterceptor` | *"a no-op **so app modules can declare the import** without churn"* | **zero** app modules import it |

The two placeholders justify themselves by a usage the code contradicts: they exist so that callers can import them, and no caller imports them. That is not a reserved surface — it is dead code with a story attached, and the story is what makes it dangerous. `CLAUDE.md`, `README.md` and ADR-008 all list `RabbitmqClientFactory` as part of the messaging API, so the next contributor believes it is load-bearing.

This is the [ADR-043](043-lifting-forced-duplicates-into-shared-libs.md) `MessagingModule` pattern exactly: a lib export whose only importer was one that did not use it.

**The distinction that matters.** This repository does keep deliberately reserved surfaces — the unused `EXCHANGES` members, the unused `CACHE_KEYS` builders. Those are **one line in a registry**, where being a complete registry is the point. These three are *files with implementations*, each asserting it has users.

### The map was wrong in both directions

`CLAUDE.md` was validated (2026-07-12) for "everything stated exists". It was never validated for **"everything that exists is stated"** — and that blind spot let both errors stand:

- it **lists** `RabbitmqClientFactory` (dead);
- it **omits** `sendPreservingRpcError` (live — four retail adapters) and `enforceRequiredClaim` (live — two guards).

## Decision

### 1. Delete the three dead exports

`libs/messaging/rabbitmq.client.factory.ts`, `libs/observability/metrics.module.ts`, `libs/observability/trace-context.interceptor.ts`, and their barrel entries. ADR-007 §, ADR-008's API table and ADR-015 are amended.

If Prometheus metrics or a response-header trace interceptor are wanted later, they will be written then, against the requirement that exists then. An empty class today buys nothing: nothing imports it, so nothing is spared "churn" by its existence.

### 2. Group the three flat libraries by family

```
libs/messaging/  12 → 5 root      libs/auth/  12 → 5 root      libs/observability/  8 → 3 root
├── clients/         (7)          ├── guards/      (4)          ├── correlation/   (4)
├── exchanges.constants.ts        ├── decorators/  (4)          ├── testing/       ← tsconfig alias
├── routing-keys.constants.ts     ├── auth.module.ts            ├── logger.module.ts
├── ris-events-mirror.publisher.ts├── auth-user-validator.port.ts└── tracer.ts     ← tsconfig alias
└── rpc-passthrough.ts            ├── jwt.strategy.ts
                                  └── role.enum.ts
```

`decorators/` is not an invention — `libs/cache/decorators/` already establishes it. `claim-guard.util.ts` goes into `guards/`, its only two callers.

`database`, `ddd` and `config` stay flat. Five or six coherent files do not need a folder to explain them, and adding one would be structure for its own sake.

**`tracer.ts` and `testing/` do not move.** They are the only two deep-import paths into any lib (`@retail-inventory-system/observability/{tracer,testing}`), pinned in `tsconfig.json`; `main.ts` depends on `tracer` being the first import in the process.

### 3. This reorganisation is invisible from outside

Every other consumer reaches a lib through its barrel, so no import in `apps/` changed. And the `boundaries` element patterns are `libs/<name>/**` — subfolders are transparent to the linter, so there is no rule to update and no rule that could break. Zero behaviour change; `yarn lint`, `build`, 1777 unit tests and 58 e2e suites all pass untouched.

The honest framing: **§2 is cosmetics.** It buys readability and nothing else, and it moves the blame on fifteen files. §1 and §4 are not.

### 4. The map now lists what is live, and only what is live

`CLAUDE.md` and `README.md` drop the three dead names and gain `sendPreservingRpcError` (the RPC-error-preserving `send` the four cross-service retail adapters use) and `enforceRequiredClaim`.

## Consequences

### Positive

- Three lib exports that lied about being used are gone, along with the ADR entries that vouched for them.
- `libs/messaging` reads as five things instead of twelve; `libs/auth` as five instead of twelve.
- The map's second direction — *does everything that exists appear here?* — is now a stated validation check, not an assumption.

### Negative

- §2 is pure churn against `git blame` for fifteen files, and buys no correctness.
- A future metrics module starts from nothing rather than from an empty class. That is the intent: an empty class is not a head start.

## Alternatives considered

- **Keep the placeholders, they cost nothing.** They cost the thing that matters most in a map: trust. `CLAUDE.md` listed `RabbitmqClientFactory` as API and an agent would have used it believing it was exercised. A reserved surface that is *one line in a registry* is cheap; a file with an implementation and a false claim of use is not.
- **Group `database` / `ddd` / `config` too, for uniformity.** Rejected: uniformity is not the goal, legibility is. Six files in `libs/ddd` are already legible; a folder would add a hop and explain nothing.
- **A `constants/` folder in `libs/messaging`** for the two `*.constants.ts`. Rejected for the same reason — two files.
- **Move `tracer.ts` under a folder for symmetry.** Rejected outright: it is a deep-import path with a `tsconfig` alias, and `main.ts`'s first-import contract (ADR-007) depends on it resolving.

---

## References

- [ADR-007](007-pino-and-opentelemetry.md) / [ADR-015](015-pino-trace-correlation.md) — introduced `TraceContextInterceptor` and `MetricsModule` as placeholders; **both are removed here**.
- [ADR-008](008-rabbitmq-via-libs-messaging.md) — its API table lists `RabbitmqClientFactory`; **that entry is removed here**, as `MessagingModule`'s was by ADR-043.
- [ADR-005](005-split-shared-common-into-bounded-libs.md) — the lib taxonomy this tidies.
- [ADR-043](043-lifting-forced-duplicates-into-shared-libs.md) — the same finding one library over: an export with no real consumer.
